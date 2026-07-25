"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as fabric from "fabric";
import Link from "next/link";
import type { PreflightResult } from "@/lib/preflight";
import { PreflightPanel } from "./preflight-panel";

type Props = {
  recipientName: string;
  garmentName: string;
  colourName: string;
  colourHex: string;
  isDark: boolean;
  notes: string | null;
  printArea: { widthPx: number; heightPx: number };
  canvas: { width: number; height: number };
  initialCanvasJson: unknown;
  status: string;
  aiEnabled: boolean;
};

const FONTS = ["Liberation Sans", "Liberation Serif", "DejaVu Sans"];
const BRUSH_COLOURS = ["#ffffff", "#111111", "#e23b2e", "#f2b134", "#3a7d44", "#2b5fa8", "#8c4fa8"];

export function Editor(props: Props) {
  const elementRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = useRef<fabric.Canvas | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [ready, setReady] = useState(false);
  const [tool, setTool] = useState<"select" | "draw">("select");
  const [brushColour, setBrushColour] = useState(props.isDark ? "#ffffff" : "#111111");
  const [brushWidth, setBrushWidth] = useState(6);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");

  // ---- setup ------------------------------------------------------------

  useEffect(() => {
    if (!elementRef.current) return;

    const canvas = new fabric.Canvas(elementRef.current, {
      width: props.canvas.width,
      height: props.canvas.height,
      // The recipient's actual shirt colour, so people design against what
      // the art will really sit on rather than against white.
      backgroundColor: props.colourHex,
      preserveObjectStacking: true,
    });

    canvasRef.current = canvas;

    if (props.initialCanvasJson) {
      canvas.loadFromJSON(props.initialCanvasJson).then(() => {
        canvas.backgroundColor = props.colourHex;
        canvas.renderAll();
      });
    }

    setReady(true);
    return () => {
      canvas.dispose();
      canvasRef.current = null;
    };
    // Built once; the recipient's garment cannot change after the draw.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      await fetch("/api/designs/autosave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canvas: canvas.toJSON() }),
      }).catch(() => {});
    }, 1200);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ready) return;

    const onChange = () => scheduleSave();
    canvas.on("object:added", onChange);
    canvas.on("object:modified", onChange);
    canvas.on("object:removed", onChange);
    canvas.on("path:created", onChange);

    return () => {
      canvas.off("object:added", onChange);
      canvas.off("object:modified", onChange);
      canvas.off("object:removed", onChange);
      canvas.off("path:created", onChange);
    };
  }, [ready, scheduleSave]);

  // ---- tools ------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.isDrawingMode = tool === "draw";
    if (canvas.isDrawingMode) {
      // PencilBrush produces vector paths, so strokes stay crisp when
      // rasterised at 4x for print rather than being upscaled pixels.
      const brush = new fabric.PencilBrush(canvas);
      brush.color = brushColour;
      brush.width = brushWidth;
      canvas.freeDrawingBrush = brush;
    }
  }, [tool, brushColour, brushWidth, ready]);

  function addImage(url: string) {
    const canvas = canvasRef.current;
    if (!canvas) return;

    fabric.FabricImage.fromURL(url, { crossOrigin: "anonymous" }).then((image) => {
      const scale = Math.min(
        (props.canvas.width * 0.8) / (image.width ?? 1),
        (props.canvas.height * 0.8) / (image.height ?? 1),
      );
      image.scale(scale);
      image.set({
        left: (props.canvas.width - (image.width ?? 0) * scale) / 2,
        top: (props.canvas.height - (image.height ?? 0) * scale) / 2,
      });
      canvas.add(image);
      canvas.setActiveObject(image);
      canvas.renderAll();
    });
  }

  function addText() {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const text = new fabric.IText("Your words", {
      left: props.canvas.width * 0.15,
      top: props.canvas.height * 0.4,
      fontFamily: FONTS[0],
      fontSize: Math.round(props.canvas.height / 14),
      fill: props.isDark ? "#ffffff" : "#111111",
    });
    canvas.add(text);
    canvas.setActiveObject(text);
    setTool("select");
    canvas.renderAll();
  }

  function deleteSelection() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.getActiveObjects().forEach((object) => canvas.remove(object));
    canvas.discardActiveObject();
    canvas.renderAll();
  }

  function moveSelection(direction: "front" | "back") {
    const canvas = canvasRef.current;
    const active = canvas?.getActiveObject();
    if (!canvas || !active) return;
    if (direction === "front") canvas.bringObjectToFront(active);
    else canvas.sendObjectToBack(active);
    canvas.renderAll();
  }

  // ---- server actions ---------------------------------------------------

  async function upload(file: File, removeBackground: boolean) {
    setBusy("Preparing your image…");
    setError(null);

    const form = new FormData();
    form.append("file", file);
    form.append("removeBackground", String(removeBackground));

    const response = await fetch("/api/assets", { method: "POST", body: form });
    const payload = await response.json();
    setBusy(null);

    if (!response.ok) return setError(payload.error);
    addImage(payload.url);
  }

  async function generate() {
    if (prompt.trim().length < 3) return setError("Describe what you'd like to make.");
    setBusy("Generating…");
    setError(null);

    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, aspect: "portrait" }),
    });
    const payload = await response.json();
    setBusy(null);

    if (!response.ok) return setError(payload.error);
    addImage(payload.url);
  }

  async function submit() {
    const canvas = canvasRef.current;
    if (!canvas) return;

    setBusy("Rendering your design at print size…");
    setError(null);

    // toSVG rather than a raster export: the browser never allocates a
    // print-resolution canvas, and vectors rasterise sharply server-side.
    const svg = canvas.toSVG();

    const response = await fetch("/api/designs/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ svg }),
    });
    const payload = await response.json();
    setBusy(null);

    if (!response.ok) return setError(payload.error);
    setPreflight(payload.preflight);
    setPreviewUrl(payload.previewUrl);
  }

  /** Re-submits after a remedy so the person sees the fix land. */
  async function applyRemedy(remedy: string) {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const images = canvas.getObjects().filter((o) => o.type === "image") as fabric.FabricImage[];
    if (images.length === 0) {
      return setError("That fix applies to an image layer, and this design doesn't have one.");
    }

    setBusy("Applying the fix…");
    setError(null);

    // Remedies act on the source asset - soft alpha and low resolution come
    // from raster layers; brush strokes and text never produce a halo.
    for (const image of images) {
      const src = image.getSrc();
      const response = await fetch("/api/designs/remedy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetId: src, remedy }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setBusy(null);
        return setError(payload.error);
      }
      await image.setSrc(payload.url, { crossOrigin: "anonymous" });
    }

    canvas.renderAll();
    setBusy(null);
    await submit();
  }

  return (
    <main className="space-y-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Designing for {props.recipientName}</h1>
          <p className="text-sm text-ink/60">
            {props.colourName} {props.garmentName} · prints at{" "}
            {props.printArea.widthPx / 300}&quot; x {props.printArea.heightPx / 300}&quot;
          </p>
        </div>
        <Link href="/dashboard" className="text-sm underline">
          Back to dashboard
        </Link>
      </header>

      {props.notes && (
        <p className="card italic">&ldquo;{props.notes}&rdquo;</p>
      )}

      {props.isDark && (
        <p className="card bg-ink/5 text-sm text-ink/70">
          {props.colourName} is a dark shirt. The printer lays white ink under the design, so soft
          glows and faded edges come out as a chalky halo, and black prints grey. Leave anything you
          want to read as black fully transparent so the shirt shows through.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[auto,1fr]">
        <div className="space-y-3">
          <div
            className="inline-block rounded-lg p-2"
            style={{ backgroundColor: props.isDark ? "#f3f3f3" : "#e6e2da" }}
          >
            <canvas ref={elementRef} className="touch-none rounded shadow-sm" />
          </div>
          <p className="text-xs text-ink/50">
            The canvas is the printable area — anything you put here fits the shirt.
          </p>
        </div>

        <div className="space-y-4">
          <section className="card space-y-3">
            <div className="flex flex-wrap gap-2">
              <button
                className={tool === "select" ? "btn-primary" : "btn-secondary"}
                onClick={() => setTool("select")}
              >
                Move
              </button>
              <button
                className={tool === "draw" ? "btn-primary" : "btn-secondary"}
                onClick={() => setTool("draw")}
              >
                Draw
              </button>
              <button className="btn-secondary" onClick={addText}>
                Add text
              </button>
              <button className="btn-secondary" onClick={deleteSelection}>
                Delete
              </button>
              <button className="btn-secondary" onClick={() => moveSelection("front")}>
                Bring forward
              </button>
              <button className="btn-secondary" onClick={() => moveSelection("back")}>
                Send back
              </button>
            </div>

            {tool === "draw" && (
              <div className="space-y-2 border-t border-black/10 pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  {BRUSH_COLOURS.map((colour) => (
                    <button
                      key={colour}
                      aria-label={`Brush colour ${colour}`}
                      onClick={() => setBrushColour(colour)}
                      className={`h-8 w-8 rounded-full border border-black/20 ${
                        brushColour === colour ? "ring-2 ring-pine ring-offset-2" : ""
                      }`}
                      style={{ backgroundColor: colour }}
                    />
                  ))}
                </div>
                <label className="block text-sm">
                  Brush size
                  <input
                    type="range"
                    min={1}
                    max={40}
                    value={brushWidth}
                    onChange={(event) => setBrushWidth(Number(event.target.value))}
                    className="ml-2 align-middle"
                  />
                </label>
              </div>
            )}
          </section>

          <section className="card space-y-3">
            <h2 className="font-medium">Add artwork</h2>
            <label className="block text-sm">
              <span className="label">Upload an image</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/svg+xml"
                className="field"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) upload(file, false);
                  event.target.value = "";
                }}
              />
            </label>
            <p className="text-xs text-ink/50">
              Made something in ChatGPT or Procreate? Upload it here — it gets scaled to print
              resolution automatically.
            </p>
          </section>

          {props.aiEnabled && (
            <section className="card space-y-3">
              <h2 className="font-medium">Or describe one</h2>
              <textarea
                rows={2}
                className="field"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="A linocut-style badger riding a bicycle, bold shapes, no background"
              />
              <button className="btn-secondary" onClick={generate} disabled={Boolean(busy)}>
                Generate
              </button>
            </section>
          )}

          {busy && <p className="text-sm text-ink/60">{busy}</p>}
          {error && <p className="text-sm text-cranberry">{error}</p>}

          <button className="btn-primary w-full" onClick={submit} disabled={Boolean(busy) || !ready}>
            Check and save my design
          </button>

          {preflight && (
            <PreflightPanel
              result={preflight}
              previewUrl={previewUrl}
              onRemedy={applyRemedy}
              busy={Boolean(busy)}
            />
          )}
        </div>
      </div>
    </main>
  );
}
