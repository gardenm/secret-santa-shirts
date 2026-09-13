"use client";

import type { Finding, PreflightResult, Remedy } from "@/lib/preflight";

/**
 * Preflight results.
 *
 * Every finding that has a fix shows the button for it. A bare "your image is
 * too small" leaves someone stuck who does not know what to do next - and that
 * person then messages the organizer, which is the outcome this app exists to
 * avoid.
 */

const REMEDY_LABELS: Record<Remedy, string> = {
  upscale: "Scale it up for me",
  "place-smaller": "Place it smaller",
  "remove-background": "Remove the background",
  "fit-to-safe-area": "Fit inside the print area",
  "flatten-alpha": "Harden the soft edges",
  "make-transparent": "Make the black transparent",
  "adjust-contrast": "Show me on the shirt colour",
};

/** Fixes the server can apply to an image layer. The rest are guidance. */
const ACTIONABLE: Remedy[] = ["upscale", "remove-background", "flatten-alpha", "make-transparent"];

/**
 * The two that call a paid model. The other two run on our own server, so they
 * stay available after the allowance is gone - which is worth saying out loud,
 * because a disabled button with no explanation is worse than a limit.
 */
const PAID: Remedy[] = ["upscale", "remove-background"];

export function PreflightPanel({
  result,
  previewUrl,
  onRemedy,
  busy,
  assistsLeft,
}: {
  result: PreflightResult;
  previewUrl: string | null;
  onRemedy: (remedy: Remedy) => void;
  busy: boolean;
  assistsLeft: number;
}) {
  const errors = result.findings.filter((f) => f.level === "error");
  const warnings = result.findings.filter((f) => f.level === "warning");

  return (
    <section className="card space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="font-medium">
          {result.ok ? "Saved — this is ready to print" : "Not ready to print yet"}
        </h2>
        <span className="text-xs text-ink/50">
          {result.meta.widthPx}×{result.meta.heightPx} · {result.meta.effectiveDpi} DPI
        </span>
      </div>

      {previewUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={previewUrl}
          alt="Your design on the shirt colour"
          className="w-full max-w-xs rounded-lg border border-black/10"
        />
      )}

      {result.ok && warnings.length === 0 && (
        <p className="text-sm text-ink/70">
          Nothing to fix. You can keep tweaking it until the deadline.
        </p>
      )}

      {errors.map((finding) => (
        <FindingRow
          key={finding.code}
          finding={finding}
          onRemedy={onRemedy}
          busy={busy}
          assistsLeft={assistsLeft}
        />
      ))}
      {warnings.map((finding) => (
        <FindingRow
          key={finding.code}
          finding={finding}
          onRemedy={onRemedy}
          busy={busy}
          assistsLeft={assistsLeft}
        />
      ))}

      {warnings.length > 0 && result.ok && (
        <p className="text-xs text-ink/50">
          Warnings are judgement calls — your design is saved either way.
        </p>
      )}
    </section>
  );
}

function FindingRow({
  finding,
  onRemedy,
  busy,
  assistsLeft,
}: {
  finding: Finding;
  onRemedy: (remedy: Remedy) => void;
  busy: boolean;
  assistsLeft: number;
}) {
  const canFix = finding.remedy && ACTIONABLE.includes(finding.remedy);
  const costsMoney = finding.remedy ? PAID.includes(finding.remedy) : false;
  const outOfAllowance = costsMoney && assistsLeft <= 0;

  return (
    <div
      className={`rounded-lg p-3 text-sm ${
        finding.level === "error" ? "bg-cranberry/5 text-ink" : "bg-ink/5 text-ink/80"
      }`}
    >
      <p>{finding.message}</p>
      {canFix && (
        <button
          className="btn-secondary mt-2"
          disabled={busy || outOfAllowance}
          onClick={() => onRemedy(finding.remedy!)}
        >
          {REMEDY_LABELS[finding.remedy!]}
        </button>
      )}
      {outOfAllowance && (
        <p className="mt-2 text-xs text-ink/50">
          You&rsquo;ve used up the automatic fixes that run on an outside service. You can still
          edit the image yourself and upload it again.
        </p>
      )}
    </div>
  );
}
