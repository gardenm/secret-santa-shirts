import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { assignments, designs, events, participants } from "@/db/schema";
import { getAsset } from "./storage";

/**
 * The order bundle.
 *
 * This is the deliverable: everything a print shop needs to make a dozen
 * different shirts without mismatching any of them.
 *
 * Split into `collectExportEntries` (all the logic, testable) and `zipEntries`
 * (a thin archiver call). Tests assert on the entry list rather than on zip
 * bytes, which tests what matters rather than someone else's compression.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any;

export class ExportError extends Error {}

export type ExportEntry = { name: string; data: Buffer };

export type ExportResult = {
  entries: ExportEntry[];
  /** People with no submitted design. Reported loudly, never dropped. */
  missing: string[];
  rows: ExportRow[];
};

export type ExportRow = {
  index: number;
  code: string;
  recipient: string;
  designer: string;
  garmentModel: string;
  garmentName: string;
  colourName: string;
  colourHex: string;
  size: string;
  fit: string;
  printFile: string;
  printDimensions: string;
  notes: string;
};

export type ExportOptions = {
  /**
   * Names files by code and keeps the design->person mapping in a separate
   * file, so an organizer who wants to be surprised too can assemble the order
   * without seeing whose shirt is whose.
   */
  blind?: boolean;
};

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 32);
}

/** Short stable code, used for blind exports. */
function codeFor(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 6).toUpperCase();
}

export async function collectExportEntries(
  db: Db,
  eventId: string,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const [event] = await db.select().from(events).where(eq(events.id, eventId));
  if (!event) throw new ExportError("Event not found.");

  const roster = await db.query.participants.findMany({
    where: (p: any, { eq: equals }: any) => equals(p.eventId, eventId),
    with: { garment: true, colour: true },
  });

  if (roster.length === 0) throw new ExportError("Nobody is in this exchange yet.");

  const allAssignments = await db
    .select()
    .from(assignments)
    .where(eq(assignments.eventId, eventId));
  if (allAssignments.length === 0) {
    throw new ExportError("The draw hasn't run yet, so there are no designs to export.");
  }

  const allDesigns = await db.select().from(designs);
  const designByAssignment = new Map<string, any>(allDesigns.map((d: any) => [d.assignmentId, d]));
  const nameById = new Map<string, string>(roster.map((p: any) => [p.id, p.displayName]));

  const entries: ExportEntry[] = [];
  const missing: string[] = [];
  const rows: ExportRow[] = [];
  const mockups: Array<{ label: string; data: Buffer }> = [];

  // Ordered by name so the bundle is stable between exports - a shop working
  // from a re-downloaded zip should see the same numbering.
  const ordered = [...roster].sort((a: any, b: any) =>
    a.displayName.localeCompare(b.displayName),
  );

  let index = 0;
  for (const person of ordered) {
    const assignment = allAssignments.find((a: any) => a.recipientId === person.id);
    const design = assignment ? designByAssignment.get(assignment.id) : undefined;

    if (!assignment || !design || design.status !== "submitted" || !design.printFileUrl) {
      missing.push(person.displayName);
      continue;
    }

    index += 1;
    const code = codeFor(person.id);
    const printFile = await getAsset(design.printFileUrl.replace("/api/assets/", ""));

    // A print file is rendered against the recipient's garment at submit time.
    // If that garment changed afterwards - an admin override, say - the stored
    // file no longer matches, and the shop would crop or scale it without
    // telling anyone. Refuse instead.
    if (person.garment) {
      const meta = await sharp(printFile).metadata();
      if (meta.width !== person.garment.printWPx || meta.height !== person.garment.printHPx) {
        throw new ExportError(
          `${person.displayName}'s print file is ${meta.width}x${meta.height}, but their ` +
            `${person.garment.displayName} needs ${person.garment.printWPx}x${person.garment.printHPx}. ` +
            `Their garment probably changed after the design was made - ask them to open the ` +
            `design and save it again.`,
        );
      }
    }

    const stem = options.blind
      ? `${String(index).padStart(2, "0")}_${code}`
      : `${String(index).padStart(2, "0")}_${slug(person.displayName)}_` +
        `${slug(person.garment?.model ?? "unknown")}_${slug(person.colour?.name ?? "unknown")}_` +
        `${person.size ?? "?"}_${person.fit ?? "?"}`;

    const printName = `prints/${stem}.png`;
    entries.push({ name: printName, data: printFile });

    if (design.previewUrl) {
      const preview = await getAsset(design.previewUrl.replace("/api/assets/", ""));
      entries.push({ name: `mockups/${stem}.png`, data: preview });
      mockups.push({ label: options.blind ? code : person.displayName, data: preview });
    }

    rows.push({
      index,
      code,
      recipient: options.blind ? code : person.displayName,
      designer: options.blind ? "" : String(nameById.get(assignment.giverId) ?? ""),
      garmentModel: person.garment?.model ?? "",
      garmentName: person.garment?.displayName ?? "",
      colourName: person.colour?.name ?? "",
      colourHex: person.colour?.hex ?? "",
      size: person.size ?? "",
      fit: person.fit ?? "",
      printFile: printName,
      printDimensions: person.garment
        ? `${person.garment.printWPx}x${person.garment.printHPx}`
        : "",
      notes: options.blind ? "" : (person.notes ?? ""),
    });
  }

  entries.push({
    name: "manifest.csv",
    data: Buffer.from(manifestCsv(rows, missing), "utf8"),
  });

  entries.push({
    name: "README.txt",
    data: Buffer.from(readme(event.name, rows, missing, options), "utf8"),
  });

  if (mockups.length > 0) {
    entries.push({ name: "contact-sheet.png", data: await contactSheet(mockups) });
  }

  if (options.blind) {
    // The sealed half of a blind export: kept separate so the organizer can
    // hand the rest to a printer, or to someone else, without seeing it.
    entries.push({
      name: "SEALED-mapping.csv",
      data: Buffer.from(
        ["code,recipient,designer"]
          .concat(
            ordered
              .filter((p: any) => !missing.includes(p.displayName))
              .map((p: any) => {
                const assignment = allAssignments.find((a: any) => a.recipientId === p.id);
                const designer = assignment ? nameById.get(assignment.giverId) : "";
                return `${codeFor(p.id)},${csv(p.displayName)},${csv(String(designer ?? ""))}`;
              }),
          )
          .join("\n"),
        "utf8",
      ),
    });
  }

  return { entries, missing, rows };
}

function csv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function manifestCsv(rows: ExportRow[], missing: string[]): string {
  const lines: string[] = [];

  // Missing shirts go at the top, where they cannot be scrolled past. Finding
  // one absent at the print shop is far worse than seeing it flagged here.
  if (missing.length > 0) {
    lines.push(`# WARNING: ${missing.length} ${missing.length === 1 ? "person has" : "people have"} no finished design`);
    for (const name of missing) lines.push(`# missing,${csv(name)}`);
    lines.push("#");
  }

  lines.push(
    "index,recipient,garment,model,colour,colour_hex,size,fit,print_file,print_dimensions,designer,notes",
  );

  // Grouped by garment model: vendor bulk forms are filled in one product at a
  // time, so this saves the organizer sorting it by hand.
  const sorted = [...rows].sort(
    (a, b) => a.garmentModel.localeCompare(b.garmentModel) || a.index - b.index,
  );

  for (const row of sorted) {
    lines.push(
      [
        row.index,
        csv(row.recipient),
        csv(row.garmentName),
        csv(row.garmentModel),
        csv(row.colourName),
        row.colourHex,
        row.size,
        row.fit,
        csv(row.printFile),
        row.printDimensions,
        csv(row.designer),
        csv(row.notes),
      ].join(","),
    );
  }

  return lines.join("\n");
}

function readme(
  eventName: string,
  rows: ExportRow[],
  missing: string[],
  options: ExportOptions,
): string {
  const byModel = new Map<string, number>();
  for (const row of rows) byModel.set(row.garmentName, (byModel.get(row.garmentName) ?? 0) + 1);

  return [
    `${eventName} - print order`,
    "",
    `${rows.length} ${rows.length === 1 ? "shirt" : "shirts"} to print.`,
    "",
    "Quantities by garment:",
    ...[...byModel.entries()].map(([name, count]) => `  ${count}x ${name}`),
    "",
    missing.length > 0
      ? `WARNING: no finished design for ${missing.join(", ")}. ` +
        `Those shirts are NOT in this bundle.`
      : "Every participant has a finished design.",
    "",
    "For the printer:",
    "  - Direct-to-garment (DTG). Every design is different, so screen printing",
    "    would charge a separate setup fee for each one.",
    "  - Print files are PNG at 300 DPI with transparent backgrounds. Print the",
    "    transparency as-is: do not add a white background, or the shirt gets a",
    "    printed rectangle instead of just the artwork.",
    "  - Each file is already sized to its garment's print area. Do not rescale.",
    "  - Match files to shirts using manifest.csv. The filename carries the",
    "    garment, colour and size for exactly this reason.",
    "",
    options.blind
      ? "This is a blind export: names are in SEALED-mapping.csv, which you can\nleave unopened if you want to be surprised too."
      : "",
    "Before ordering all of these, order ONE and check it. It is the only way to",
    "catch a colour shift or scale problem while it is still fixable.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Every design on one image, for eyeballing the whole order at a glance.
 * Composited with sharp rather than adding a PDF library for no real gain.
 */
async function contactSheet(mockups: Array<{ label: string; data: Buffer }>): Promise<Buffer> {
  const columns = Math.min(4, mockups.length);
  const rows = Math.ceil(mockups.length / columns);
  const cell = 320;
  const pad = 16;

  const width = columns * cell + pad * (columns + 1);
  const height = rows * cell + pad * (rows + 1);

  const tiles = await Promise.all(
    mockups.map(async (mockup, i) => ({
      input: await sharp(mockup.data)
        .resize(cell, cell, { fit: "contain", background: "#ffffff" })
        .png()
        .toBuffer(),
      left: pad + (i % columns) * (cell + pad),
      top: pad + Math.floor(i / columns) * (cell + pad),
    })),
  );

  return sharp({
    create: { width, height, channels: 4, background: "#f4f1ec" },
  })
    .composite(tiles)
    .png()
    .toBuffer();
}

/** Thin wrapper: zips whatever collectExportEntries produced. */
export async function zipEntries(entries: ExportEntry[]): Promise<Buffer> {
  const archiver = (await import("archiver")).default;
  const archive = archiver("zip", { zlib: { level: 6 } });

  const chunks: Buffer[] = [];
  archive.on("data", (chunk: Buffer) => chunks.push(chunk));

  const done = new Promise<void>((resolve, reject) => {
    archive.on("end", () => resolve());
    archive.on("error", reject);
  });

  for (const entry of entries) archive.append(entry.data, { name: entry.name });
  await archive.finalize();
  await done;

  return Buffer.concat(chunks);
}
