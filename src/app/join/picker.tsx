"use client";

import { useActionState, useMemo, useState } from "react";
import { saveShirt } from "../actions";

type Colour = {
  id: string;
  name: string;
  hex: string;
  isDark: boolean;
  availableSizes: string[];
};

export type CatalogEntry = {
  id: string;
  displayName: string;
  sizes: string[];
  fits: string[];
  colours: Colour[];
};

export function GarmentPicker({
  catalog,
  initial,
}: {
  catalog: CatalogEntry[];
  initial?: { garmentId?: string; colourId?: string; size?: string; fit?: string; notes?: string };
}) {
  const [state, action, pending] = useActionState(saveShirt, null);

  const [garmentId, setGarmentId] = useState(initial?.garmentId ?? catalog[0]?.id ?? "");
  const garment = useMemo(
    () => catalog.find((g) => g.id === garmentId) ?? catalog[0],
    [catalog, garmentId],
  );

  const [colourId, setColourId] = useState(initial?.colourId ?? garment?.colours[0]?.id ?? "");
  const colour = garment?.colours.find((c) => c.id === colourId) ?? garment?.colours[0];

  const [size, setSize] = useState(initial?.size ?? "");

  // Sizes are filtered to what this specific colour is stocked in - not every
  // colour exists in every size, and finding out at order time is too late.
  const sizes = colour?.availableSizes ?? [];
  const unavailable = garment?.sizes.filter((s) => !sizes.includes(s)) ?? [];

  function chooseGarment(id: string) {
    setGarmentId(id);
    const next = catalog.find((g) => g.id === id);
    setColourId(next?.colours[0]?.id ?? "");
    setSize("");
  }

  function chooseColour(id: string) {
    setColourId(id);
    const next = garment?.colours.find((c) => c.id === id);
    if (size && next && !next.availableSizes.includes(size)) setSize("");
  }

  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="garmentId" value={garmentId} />
      <input type="hidden" name="colourId" value={colourId} />

      <section className="card space-y-3">
        <h2 className="font-medium">Which garment?</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {catalog.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => chooseGarment(entry.id)}
              className={`rounded-lg border px-4 py-3 text-left text-sm transition ${
                entry.id === garmentId
                  ? "border-pine bg-pine/5 ring-1 ring-pine"
                  : "border-black/15 hover:bg-black/5"
              }`}
            >
              {entry.displayName}
            </button>
          ))}
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="font-medium">Colour</h2>
        <div className="flex flex-wrap gap-2">
          {garment?.colours.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => chooseColour(c.id)}
              title={c.name}
              aria-label={c.name}
              aria-pressed={c.id === colourId}
              className={`h-10 w-10 rounded-full border transition ${
                c.id === colourId
                  ? "ring-2 ring-pine ring-offset-2"
                  : "border-black/20 hover:scale-105"
              }`}
              style={{ backgroundColor: c.hex }}
            />
          ))}
        </div>
        {colour && (
          <p className="text-sm text-ink/70">
            {colour.name}
            {colour.isDark && (
              <>
                {" — "}
                <span>
                  a dark shirt, so whoever designs for you will avoid soft glows and faded edges
                  (they print as a chalky halo).
                </span>
              </>
            )}
          </p>
        )}
      </section>

      <section className="card space-y-3">
        <h2 className="font-medium">Size</h2>
        <div className="flex flex-wrap gap-2">
          {sizes.map((s) => (
            <label
              key={s}
              className={`cursor-pointer rounded-lg border px-4 py-2 text-sm ${
                size === s ? "border-pine bg-pine/5 ring-1 ring-pine" : "border-black/15 hover:bg-black/5"
              }`}
            >
              <input
                type="radio"
                name="size"
                value={s}
                checked={size === s}
                onChange={() => setSize(s)}
                className="sr-only"
                required
              />
              {s}
            </label>
          ))}
        </div>
        {unavailable.length > 0 && (
          <p className="text-xs text-ink/60">
            Not stocked in {colour?.name}: {unavailable.join(", ")}. Pick another colour if you need
            one of those.
          </p>
        )}
      </section>

      {garment && garment.fits.length > 1 ? (
        <section className="card space-y-3">
          <h2 className="font-medium">Fit</h2>
          <select name="fit" className="field" defaultValue={initial?.fit ?? garment.fits[0]}>
            {garment.fits.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </section>
      ) : (
        <input type="hidden" name="fit" value={garment?.fits[0] ?? "unisex"} />
      )}

      <section className="card space-y-2">
        <label className="label" htmlFor="notes">
          Anything your designer should know? (optional)
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          className="field"
          defaultValue={initial?.notes ?? ""}
          placeholder="Things you like, things to avoid — &ldquo;I love dinosaurs, please no politics&rdquo;"
        />
      </section>

      {state && !state.ok && <p className="text-sm text-cranberry">{state.error}</p>}

      <button type="submit" className="btn-primary" disabled={pending || !size}>
        {pending ? "Saving…" : "Save my shirt"}
      </button>
    </form>
  );
}
