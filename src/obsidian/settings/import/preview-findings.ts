import type { InkImportPreview } from "../../import/types";

export interface ImportPreviewFinding {
  readonly category: "difference" | "warning" | "skipped";
  readonly message: string;
  readonly sources: readonly string[];
  readonly notes: readonly string[];
}

interface FindingGroup {
  readonly category: ImportPreviewFinding["category"];
  readonly message: string;
  readonly sources: Set<string>;
  readonly notes: Set<string>;
}

const APPEARANCE_DIFFERENCES = new Set([
  "Stroke outlines, smoothing and pressure response use Inkbook's native brush.",
  "Legacy stroke rendering uses Inkbook's native brush.",
  "Theme palette colors were frozen to Obsidian's default palette.",
  "Legacy palette colors were frozen to tldraw's light palette.",
  "Closed freehand paths use Inkbook's native open stroke caps.",
  "Curved arrows use Inkbook's native bend geometry.",
  "Hand-drawn shape outlines were converted to native solid outlines.",
  "Pattern fills were converted to native solid fills.",
  "Rounded rectangles were converted to Inkbook rectangles with square corners.",
  "Combined ruled and grid backgrounds were reduced to the grid.",
  "Geometry, pressure and opacity were rounded to Inkbook's native precision.",
  "Stroke width was mapped to the nearest Inkbook preset.",
  "Outline width was mapped to the nearest Inkbook preset.",
  "Background spacing was mapped to the nearest Inkbook preset.",
]);

function category(message: string): ImportPreviewFinding["category"] {
  return APPEARANCE_DIFFERENCES.has(message) ? "difference" : "warning";
}

function groupFinding(groups: Map<string, FindingGroup>, finding: ImportPreviewFinding): void {
  const key = `${finding.category}:${finding.message}`;
  let group = groups.get(key);
  if (group === undefined) {
    group = {
      category: finding.category,
      message: finding.message,
      sources: new Set(),
      notes: new Set(),
    };
    groups.set(key, group);
  }
  for (const source of finding.sources) group.sources.add(source);
  for (const note of finding.notes) group.notes.add(note);
}

function scanFinding(message: string): ImportPreviewFinding {
  const sourcePrefixes = ["Missing source: ", "Unsupported or invalid writing source: "];
  for (const prefix of sourcePrefixes) {
    if (message.startsWith(prefix)) {
      return {
        category: "skipped",
        message: prefix.slice(0, -2),
        sources: [message.slice(prefix.length)],
        notes: [],
      };
    }
  }
  const unreadable = "Could not inspect note: ";
  if (message.startsWith(unreadable)) {
    return {
      category: "skipped",
      message: "Could not inspect note",
      sources: [],
      notes: [message.slice(unreadable.length)],
    };
  }
  // The scan's unresolved-reference string cannot delimit arbitrary note/link paths safely.
  // Retain it verbatim rather than attributing the omission to a guessed path.
  return {
    category: message.startsWith("Unresolved writing reference in ")
      ? "skipped"
      : category(message),
    message,
    sources: [],
    notes: [],
  };
}

export function buildImportPreviewFindings(
  preview: InkImportPreview,
): readonly ImportPreviewFinding[] {
  const groups = new Map<string, FindingGroup>();
  const sourceWarnings = new Set<string>();
  for (const source of preview.sources) {
    const notes = [...new Set(source.references.map((reference) => reference.notePath))];
    for (const message of new Set(source.warnings)) {
      sourceWarnings.add(`${source.path}: ${message}`);
      groupFinding(groups, {
        category: category(message),
        message,
        sources: [source.path],
        notes,
      });
    }
  }
  for (const finding of preview.scanFindings ?? []) {
    sourceWarnings.add(finding.original);
    groupFinding(groups, { ...finding, category: "skipped" });
  }
  for (const message of preview.warnings) {
    if (!sourceWarnings.has(message)) groupFinding(groups, scanFinding(message));
  }
  return [...groups.values()].map((group) => ({
    ...group,
    sources: [...group.sources],
    notes: [...group.notes],
  }));
}
