# Project review: what to improve before the exchange runs

> **All sixteen items are implemented.** Kept as the record of what was wrong
> and why each fix is shaped the way it is. Item 13 is the one that stayed a
> question rather than a change — see its note.

A step back over the whole project before the first real users arrive. The review covered every
route, page, server action, lib module and the test harness, plus the installed library defaults
(Better Auth, Vercel Blob). Nothing here is speculative — each item names the file and the line of
reasoning, and the ones marked *verified* were checked against installed code rather than recalled.

Each item stands alone: what's wrong, where, the fix, how to prove it. It is written so a fresh
agent or person can pick items off it without any other context.

Items are ranked by *how likely it is to bite twelve people in December*, not by effort. P0 items
would produce a visible failure during the real event. P1 is CI and correctness hygiene. P2 is
polish worth doing if there's time.

Nothing here reopens settled decisions (single event per deployment, upload-first editor,
OpenAI over Flux, Better Auth). The security invariants stand: the invite list is the ACL,
assignments are read only via `getMyAssignment`, `inlineAssets()` never fetches client URLs, and
the `db:init` single-event guard stays.

---

## P0 — would bite the real event

### 1. ✅ The deadline is at midnight UTC, which is the previous evening in Canada

`db:init` parses `"2026-12-01"` with `new Date()` → `2026-12-01T00:00:00Z`. `extendDeadline` in
`src/app/actions.ts:119` does the same from a `<input type="date">`. For a group in Toronto that is
**7 pm on November 30**; in Vancouver, 4 pm. `submitDesign` (`src/lib/submit.ts:52`) enforces it
server-side, so people who believe they have all of December 1st get refused the evening before.

It also breaks the reminders, *verified by tracing the cron*: the cron runs at 16:00 UTC
(`vercel.json`). On deadline day, `stateFor` locks the event **first** (`remind/route.ts:44`), then
`remindersDue` sees `state: "locked"` and returns nothing (`reminders.ts:56`). So the
`daysLeft === 0` "Today's the deadline" nudge in `REMINDER_DAYS` can never fire. The unit test
for it passes because it's given `state: "open"` directly — the state the route never gives it.

**Fix:**
- Add `EVENT_TIMEZONE` env (default `America/Toronto`) and one helper, `endOfDayIn(dateString, tz)`,
  in a new `src/lib/dates.ts`. Use it in `db/init.ts` and `extendDeadline` so a deadline of
  "Dec 1" means 23:59:59 on Dec 1 *in the group's timezone*. Same for `revealAt`.
- Make `daysUntil` count days in that timezone, and **delete the second `daysUntil`** in
  `dashboard/page.tsx:9` (it's `Math.ceil` on milliseconds — a different answer from the
  reminders' UTC-midnight one; two definitions of "days left" is how the dashboard and the email
  disagree).
- Replace every `toLocaleDateString()` (dashboard, reveal, submit error) with a formatter that
  passes `timeZone: EVENT_TIMEZONE`. On Vercel the server locale is UTC, so today those render
  the wrong day for the same reason.
- Move the cron to run **after** local midnight but treat the deadline as end-of-day, so day-0
  reminders go out on the deadline morning and the lock happens the next run.

**Verify:** a test in `reminders.test.ts` that drives the *route's* sequence — `stateFor` then
`remindersDue` with the result — across a deadline set by `endOfDayIn`, and asserts a day-0 nudge
is produced on the deadline date and the lock lands the day after. That's the test that would have
caught this.

### 2. ✅ Magic links die after 5 minutes; the email promises 24 hours — *verified*

Better Auth's `magicLink` plugin defaults `expiresIn` to **300 seconds**
(`node_modules/better-auth/dist/plugins/magic-link/index.mjs`: `expiresIn || 300`). The email in
`src/lib/auth.ts:49` says *"expires in 24 hours."* Anyone who opens the email over lunch gets an
invalid-link error with no explanation, on their very first contact with the app.

**Fix:** set `expiresIn: 60 * 60` (an hour is plenty for a link that arrives by email) in the
plugin options and make the copy say an hour. **Verify:** a test that constructs the auth config
and asserts the plugin option — cheap, and it pins the copy to the config so they can't drift.

### 3. ✅ Signed-out visitors get a crash page, not a sign-in page

There is no `middleware.ts`, no `error.tsx`, no `not-found.tsx`. Every protected page calls
`requireSession()`, which **throws** (`src/lib/auth.ts:107`). In production Next strips the
message, so bookmarking `/dashboard` while signed out — or after the session expires — shows
"Application error: a server-side exception has occurred". Same for someone removed from the
invite list (`auth.ts:111`): the intended "your access was revoked" outcome renders as a crash.

**Fix:**
- Split the helper: keep `requireSession()` throwing for API routes (they already catch and
  return 401), and add `requirePageSession()` for pages that calls `redirect("/signin")` when
  signed out. Update the pages: `dashboard`, `admin`, `design`, `join`, `reveal`. (`page.tsx`'s use
  of `currentSession` is fine as-is.)
- **Built differently:** being signed in but no longer invited *redirects* to a `/no-access` page
  rather than throwing a message for `error.tsx` to render. The reason is the same one that makes
  this item a bug in the first place — the message we would want to show is exactly what production
  strips. A page can say it in its own words. `requirePageAdmin` sends non-organizers to
  `/dashboard`, which is theirs.
- Add `src/app/error.tsx` with a friendly message and a link home, so any *other* exception isn't
  a white page either.
- **There is no sign-out anywhere** (`grep signOut src` → nothing). Add a sign-out button to the
  layout header; Better Auth exposes `auth.api.signOut`.

**Verify:** `npm run build` then `next start` with no session cookie and `curl -I /dashboard` → 307
to `/signin`. Add a route test if the harness allows; otherwise this is the one to click through.

### 4. ✅ The magic-link sign-in has no rate limit, and a failed send looks like success

`sendMagicLink` in `src/app/actions.ts:30` calls `auth.api.signInMagicLink` directly. Better
Auth's rate limiter runs in the HTTP handler (`dist/api/index.mjs:172`), **not** on direct
`auth.api.*` calls, so the form can be used to fire unlimited emails at any invited address.
Separately, `sendMagicLink` in `auth.ts:40` ignores `sendAll`'s result: if Resend rejects the
send (unverified domain — the README's own warning), the user still sees "Check your email" and
nobody is told anything.

**Fix:**
- In the `sendMagicLink` hook, if `result.errors.length > 0 || result.skipped > 0`, `throw` — Better
  Auth turns that into a failed request, and the action's catch still shows the vague message to
  the user, but the failure is now **logged with the Resend error**, so the organizer can find it.
- Throttle per email, one send per minute.

**Built differently from the sketch above, on purpose.** The plan was to reuse the `verification`
table, but that table is keyed by *token*, not by email — the address is buried inside a
JSON `value` whose shape is Better Auth's private detail. Matching on it would have broken silently
the day they changed it. There is a small `sign_in_attempts` table instead (`signin-policy.ts`),
one row per address, updated in place.

It is also a single atomic upsert with `setWhere` rather than a read followed by a write: five
simultaneous requests all pass a read-then-write check before any of them writes, and all five
send. There is a test for exactly that.

The throttle runs in the server action, *before* the link is generated — a limiter that runs after
the token exists has already done the expensive part.

### 5. ✅ Hosted-model calls that cost money are uncapped

`generationsRemaining()` caps `/api/generate` only. Three other paths call fal (paid) with **no
cap at all**:
- `/api/designs/remedy` → `remove-background` (BiRefNet) and `upscale` (ESRGAN when factor > 1.5)
- `/api/assets` with `removeBackground=true` → BiRefNet
- `prepareUpload` → hosted ESRGAN for any upload needing > 1.5× (a phone screenshot always does)

A participant clicking "remove background" thirty times spends thirty fal calls. The README calls
the generation cap "the only thing standing between the organizer and an unbounded bill" — it isn't,
because these aren't behind it.

**Fix:** record every hosted call in `generations` with `provider: "fal"` and `model:
"birefnet" | "esrgan"` (the table already has the columns), and have one `hostedCallsRemaining()`
that counts *all* providers against `generationCap`. Show the remaining count in the editor next to
both the Generate button and the remedy buttons. **Verify:** extend `event-service.test.ts` — a fal
row counts against the cap.

### 6. ✅ Vercel Blob is public; designs are supposed to be secret until the reveal

`storage.ts:49` uses `access: "public"`. The app gates `/api/assets/[id]` on a session, but the
underlying blob URL is world-readable to anyone who has it. Ids are UUIDs so it isn't guessable,
but a URL in a screenshot, a shared devtools tab, or Vercel's own dashboard is enough to see a
design early. *Verified:* `@vercel/blob@0.27.3`'s types only know `access: 'public'` — private
blobs need the **2.x** line.

**Fix:** upgrade `@vercel/blob` to the current major, switch to `access: "private"`, and read via
the SDK's authenticated `get`/download path rather than `fetch(meta.url)`. Confirm in the changelog
which version introduced private access before pinning. **Verify:** after deploy, the raw
`*.blob.vercel-storage.com` URL of an asset should 403; `/api/assets/<id>` should still serve it.

### 7. ✅ The cron endpoint is open when `CRON_SECRET` is unset, and reminders aren't idempotent

`remind/route.ts:30`: `!secret || header === ...` — with the secret unset in production, anyone can
hit the URL. And `reminders.ts:59` says *"the caller records what it sent"* — the route doesn't
record anything, so a manual re-trigger or a Vercel retry on a reminder day sends every nudge
twice.

**Fix:** refuse when `NODE_ENV === "production"` and `CRON_SECRET` is unset (fail closed). Add
`events.lastReminderDay` (a date) and skip the send when it already equals today in
`EVENT_TIMEZONE`. **Verify:** unit test that two runs on the same day yield one send set.

---

## P1 — CI, correctness hygiene

### 8. ✅ There is no CI

No `.github/` directory exists. Add `.github/workflows/ci.yml`:
- `actions/setup-node` with `node-version-file: .nvmrc`, `npm ci`
- `npm run typecheck`, `npm test`, `npm run build` (build needs placeholder `DATABASE_URL`,
  `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` — set them as job env, not secrets)
- **Migration drift check:** `npx drizzle-kit generate --name ci-check` and fail if it wrote a
  file. Migrations were regenerated by hand once already in this project; drift between
  `schema.ts` and `migrations/` would pass every test (PGlite applies the migrations, so the tests
  prove the *migrations* work, not that they match the schema).
- The suite is ~150 s, nearly all of it `export.test.ts` rendering at print size. Acceptable for
  CI; if it becomes a nuisance, cache one rendered fixture across that file's tests.

### 9. ✅ `npm run lint` is broken

`next lint` is in `package.json` but ESLint isn't installed and there is no config; running it
prompts interactively. The `eslint-disable` comments scattered through `src/lib/*.ts` currently
do nothing. Either add `eslint` + `eslint-config-next` with a flat config and run it in CI, or
delete the script. Recommend adding it — the `any`-typed `Db` in five modules is exactly what a
linter would flag (see 12).

### 10. ✅ Tests leave 1,500 files in `.uploads/`

`storage.ts` writes to `process.cwd()/.uploads` and tests never clean up: 1,544 files / 45 MB
after a handful of runs. Gitignored, so it's invisible until the disk fills. **Fix:** honour an
`UPLOADS_DIR` env, and in `vitest.config.ts` set it to a per-run temp dir via `globalSetup` with
teardown. This also makes `.uploads` a production-only concept.

### 11. ✅ `aspect` from the client isn't validated

`generate/route.ts:72`: `body.aspect ?? "portrait"` is passed straight to `SIZES[aspect]`. A
malformed value makes `size.width` throw a TypeError that surfaces as a 502 with an internal
message. `style` right next to it *is* validated (`isPrintStyle`) — do the same for `aspect`.

### 12. ✅ `type Db = any` in five modules

`event-service.ts`, `submit.ts`, `export.ts`, `invites.ts`, `garments.ts` all take `db: any` so
tests can inject PGlite. It costs every query its types — the `(p: any, { eq: equals }: any)`
callbacks are the symptom. **Fix:** `type Db = PgDatabase<PgQueryResultHKT, typeof schema>` from
`drizzle-orm/pg-core`, which both the postgres-js and PGlite drivers satisfy. Mechanical, and the
typecheck then covers the query layer.

### 13. ⚠️ Confirm function duration limits against the Vercel plan

`export` declares `maxDuration = 300`, `generate` and `submit` 120. Whether those are honoured
depends on the plan and whether Fluid Compute is on. Check the project settings; if the ceiling
is 60 s, `generate` (a high-quality gpt-image call plus BiRefNet plus upscale) is the one at risk.

**Still open, deliberately.** This is a question about your Vercel plan, not a defect in the code —
there is nothing to change until the real limit is known. Check it in the dashboard before the
group starts generating.

---

## P2 — polish

### 14. ✅ The editor canvas doesn't fit a phone

`DESIGN_SCALE = 4` gives an 825 × 1050 canvas for a tee, on a fixed-size `<canvas>` with no
responsive styling. On a 390 px phone it overflows horizontally. Fabric supports a CSS-only
scale: `canvas.setDimensions({ width, height }, { cssOnly: true })` on resize, keeping the backing
store at design size so exports are unchanged. "Test the editor on a real phone" is an open item —
this is what it will find.

### 15. ✅ Admin can't remove an invite or fix a garment

`adminChangeGarment()` exists in `event-service.ts:67` with no action or UI calling it, and the
"removing someone from the invite list revokes access immediately" story in the README has no
button. Both are small forms in `admin/forms.tsx` plus actions. The garment change should email
the designer (the function already returns who to tell).

### 16. ✅ Small things
- `invitepeople` → `invitePeople` (`actions.ts:61`).
- `addExclusion` doesn't check both ids belong to the event; harmless with one event, add the
  check anyway so it survives the multi-event refactor if that ever happens.
- Dashboard still says "Designs are due" with a UTC date after the deadline passed — falls out
  of item 1.
- README test count will drift again; drop the number and say "all passing".

---

## What was verified

- **192 tests** (was 156), `npm run lint`, `npm run typecheck`, `npm run build`, all on Node 24.
- The redirects in item 3 and the cron's 503 in item 7 were checked against a **running production
  build**, not just reasoned about: every protected page returns 307 to `/signin` with no session.
- The migration drift check in item 8 was tested **both ways** — no false positive on a clean tree,
  and it does catch a column added to `schema.ts` without a migration.
- The `.uploads` directory stays empty after a full suite run.

### What was not verified, and cannot be here

- **Private blob reads.** `access: "private"` and the authenticated `get()` need a real Blob store.
  After deploying, open an asset's raw `*.blob.vercel-storage.com` URL — it should 403, while
  `/api/assets/<id>` still works.
- **Magic-link sign-in end to end**, including that an *uninvited* address is refused. Needs live
  Neon and a verified Resend domain. It is the security-critical path.
- **fal metering against the real API.** No `FAL_KEY` in tests, so the hosted paths always fail and
  fall back; what is tested is that a failed call charges nobody.
- **The editor on a real phone.** Item 14 is a CSS-only canvas scale, which is the right mechanism,
  but a 390px screen is the only thing that proves it.
