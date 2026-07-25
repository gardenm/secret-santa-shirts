# secret-santa-shirts

A Secret Santa with a twist: everyone is assigned one other person and designs a
t-shirt for them. The app collects garments and sizes, runs the draw, gives
people a place to make the design, holds a deadline, and exports a print-ready
bundle for one group order.

## Status

Usable end to end: people sign in, pick a shirt, get assigned someone, and
design their shirt with drawing, AI generation and uploads. What remains is
the organizer's export bundle, reminder emails and the reveal gallery.

| Piece | State |
|---|---|
| Schema + migrations (13 tables) | Done |
| Assignment draw + tests | Done |
| Print rendering (SVG to PNG) + tests | Done |
| Preflight validation + tests | Done |
| Image generation pipeline + tests | Done |
| Auth, invites, garment picker, admin, the draw | Done |
| Design editor: draw, text, upload, AI, preflight | Done |
| Reminder emails, export bundle, reveal gallery | Not started |

`npm test` — 97 tests, all passing. `npm run build` passes.

## Setup

```bash
npm install
cp .env.example .env      # DATABASE_URL, AUTH_SECRET and RESEND_API_KEY are required
npm run db:migrate        # create the tables
npm run db:seed           # load the garment catalog
npm run db:init -- "Shirt Santa 2026" 2026-12-01 2026-12-20 you@example.com
npm run dev
```

`db:init` creates the exchange and invites the first organizer. There is no UI
for it on purpose: the invite list is the access control, so somebody has to
exist before anyone can sign in. Whoever signs in first becomes the organizer
and invites everyone else from `/admin`.

**Resend only sends from a verified domain.** `onboarding@resend.dev` works for
testing but delivers only to your own address — a confusing failure mode if you
don't know it going in.

Tests need no database, no Docker and no API keys — integration tests run
against PGlite, real Postgres compiled to WASM, in-process:

```bash
npm test
npm run typecheck
npm run build
```

## How it works

### The draw

`src/lib/draw.ts` uses **Sattolo's algorithm**, which produces a uniformly
random single-cycle permutation. Every element is guaranteed to move, so
nobody can draw themselves — no retry loop needed. A single cycle also means
no two people are ever paired with each other, which makes for a better
exchange.

Correctness is enforced in three places, deliberately: the algorithm, a
`validatePairings` check before writing, and the database itself —
`CHECK (giver_id <> recipient_id)` plus unique indexes on giver and recipient.
This is the one bug that would ruin the whole event, so it is worth the
redundancy. All three layers are tested, including the database constraints
themselves, which fire against a real Postgres in `src/db/constraints.test.ts`.

The draw runs in a single transaction: it refuses to run twice, blocks by
default if anyone hasn't chosen a shirt (their designer would have nothing to
work from), locks everyone's garment choice, and rolls back completely if the
exclusions turn out to be unsatisfiable.

Exclusions (couples, roommates) are handled by rejection sampling with a
capped attempt count and a clear error rather than an infinite loop.

### Garment choice

Everyone picks their own garment, colour, and size from a seeded catalog
(`src/db/seed-catalog.ts`). A catalog rather than free text because:

- **Print area varies by model.** A hoodie is 3000×3600 px; a tee is 3300×4200.
  Canvas size and every preflight threshold derive from the garment row —
  nothing downstream hardcodes a size.
- **Not every colour is stocked in every size.** `availableSizes` per colour
  stops someone picking something unorderable.
- **Dark garments change which designs work** — see below.

Garment choice **locks when the draw runs**. Switching from black to white
afterwards would ruin whatever the designer had already made.

### Dark garments and the white underbase

DTG printing on a dark garment lays a solid white underbase first, which
interacts badly with things people naturally draw:

- A pixel at 30% opacity still gets a **100% solid white underbase dot**. Soft
  glows, drop shadows and feathered edges print as a chalky halo.
- Black ink over a white underbase reads **grey**. Areas meant to look black
  should be fully transparent so the shirt itself shows through.
- Heavy coverage prints thick and stiff.

`src/lib/preflight.ts` raises these only for garments flagged `isDark`, and
every finding carries a **remedy** rather than just a verdict — flatten alpha,
make transparent, upscale, place smaller. A bare error message leaves someone
stuck and they ask the organizer; a one-click fix does not.

### Print rendering

The browser never holds a print-resolution canvas. The client sends
`canvas.toSVG()`, and `src/lib/render.ts` rasterises it server-side at the
recipient garment's print size via resvg. This keeps a ~55 MB allocation off
mobile Safari, makes output deterministic, and means print files can be
re-rendered at any size later if the chosen vendor wants different dimensions.

`renderDesign` asserts its own output dimensions — both of them — because two
separate resvg behaviours fail silently in ways that look like success:

> **Gotcha 1:** resvg-js discards its *entire* options object when given an
> unknown key, so one wrong font option drops `fitTo` too and the file renders
> at design scale with no error. Fonts are passed as `fontDirs`, not buffers.
>
> **Gotcha 2:** resvg renders **nothing** for any image href that is not a data
> URI — not a relative path, not a remote URL — and reports success. Fabric's
> `toSVG()` emits raw src URLs, so without `inlineAssets` below, every design
> containing an image would print blank at exactly the right dimensions.
>
> Measured: `data:image/png;base64,…` renders; `/api/assets/<id>` gives 0
> opaque pixels; `https://example.com/a.png` gives 0 opaque pixels.

### Assets and the design SVG

Uploads and generated images are stored by opaque id (`src/lib/storage.ts`,
Vercel Blob or a local directory) and served same-origin from
`/api/assets/[id]`, so the canvas is never tainted.

At submit time `inlineAssets` (`src/lib/svg-assets.ts`) rewrites every `<image>`
href into a data URI, resolving ids **directly from storage with no HTTP
request**. Only `/api/assets/<id>` and existing `data:` URIs are accepted;
anything else throws rather than rendering blank. That rule does double duty —
the SVG is client-supplied, so refusing to fetch arbitrary URLs removes the
SSRF surface entirely.

### The editor

`/design` has **no id in the URL**: the assignment comes from the session, so
ownership is structural rather than a check that could be got wrong.

The canvas is exactly a quarter of the recipient's print area, with their shirt
colour as the backdrop. Brush strokes and text are vector, so they rasterise
crisply at 4× rather than being upscaled pixels. Fonts are vendored in
`public/fonts` and the browser loads the *same* `.ttf` files via `@font-face`
that resvg reads from disk — identical files on both sides is what makes the
print file match what the designer saw.

Preflight remedies act on the **source asset**, not the flattened output: soft
alpha and low resolution belong to raster layers, while vector strokes never
produce an underbase halo. Every offered fix is tested to actually produce a
passing file — a button that promises a way out and doesn't deliver is worse
than no button.

### Image generation

A pipeline, not a model:

```
generate (quality model) → background removal → upscale → composite
```

Transparency is a **pipeline step**, not a model capability — which frees the
generation model to be chosen on quality alone, and makes uploads from ChatGPT
or a phone work the same way.

On resolution, the honest numbers: `gpt-image-2` caps at 8.29M pixels, about
2480×3312 for a 3:4 portrait. Across an 11″×14″ print that is **~225 DPI** —
above the 150 DPI floor and genuinely printable, but short of the 300 DPI
target, so an upscale runs. The gap is only **1.33×**, the easy regime for any
upscaler, quite unlike the 4× stretch from 1024px that gives AI art on fabric
its bad reputation. Choosing 11″×14″ rather than the 12″×16″ maximum is what
keeps it there.

Note `gpt-image-1` deprecates 2026-10-23; `gpt-image-1.5` supports native
transparency while `gpt-image-2` does not.

## Printing

Files are built to a vendor-agnostic spec — PNG, 300 DPI, transparent
background, sized to the garment — so they work at Printful (Toronto facility,
so Canadian orders are not cross-border), Coastal Reign (Toronto + Vancouver),
Gelato's Canadian partners, Printify, or a local shop.

Because every shirt is a different design, **DTG is the right process**;
screen printing charges per-design setup, which is what makes a dozen unique
shirts expensive.

**Order one real shirt before the group order.** It is the only way to catch a
colour shift, transparency, or scale problem while it is still fixable.

## Access control

Sign-in is passwordless (magic link) and gated on the invite list: the `signIn`
callback rejects any address not on it, so there is no second allowlist to
maintain and someone who finds the URL cannot join. Assignments are read only
through `getMyAssignment`, always filtered to the caller's own participant id —
there is deliberately no "fetch assignment by id" for a page to reach for.

## Build order

1. ~~Skeleton, schema, migrations~~ — done
2. ~~Auth, invite flow, garment picker, admin roster~~ — done
3. ~~The draw~~ — done
4. Design pipeline: canvas, upload, submit route, preflight UI, mockups
5. Editor v2: brush, text, layers, undo/redo
6. Deadline enforcement + reminder cron
7. Export bundle (ZIP + manifest.csv + contact sheet)
8. Reveal gallery

Steps 1–3 are done, which means the exchange can be sent out now: people can
join, pick shirts, and be assigned. The dashboard tells each person who they're
designing for, that person's garment, colour, size and notes, and — for dark
shirts — the underbase warning about soft edges. Design tooling can land while
people are still deciding what to make.
