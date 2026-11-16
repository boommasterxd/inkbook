import type { ObsidianInkWarningCode } from "../../../persistence/import/obsidian-ink/warnings";
import type { ImportDiagnostic } from "../../import/diagnostics";
import type { InkImportPreview } from "../../import/types";

export interface ImportPreviewFinding {
  readonly category: "difference" | "warning" | "skipped";
  readonly message: string;
  readonly diagnostic?: ImportDiagnostic;
  readonly warningCode?: ObsidianInkWarningCode;
  readonly sources: readonly string[];
  readonly notes: readonly string[];
}

interface FindingGroup {
  readonly category: ImportPreviewFinding["category"];
  readonly message: string;
  readonly diagnostic?: ImportDiagnostic;
  readonly warningCode?: ObsidianInkWarningCode;
  readonly sources: Set<string>;
  readonly notes: Set<string>;
  readonly contributions: Map<string, readonly string[]>;
  readonly selectedSources: Set<string>;
  readonly selectedNotes: Map<string, number>;
  readonly noteOrder: Set<string>;
  global: boolean;
  cached: ImportPreviewFinding | undefined;
}

const APPEARANCE_CODES = new Set<ObsidianInkWarningCode>([
  "nativeBrush",
  "legacyBrush",
  "paletteFrozen",
  "legacyPaletteFrozen",
  "openStrokeCaps",
  "arrowBend",
  "handDrawnOutline",
  "patternFill",
  "squareCorners",
  "combinedBackground",
  "nativePrecision",
  "strokeWidthPreset",
  "outlineWidthPreset",
  "backgroundSpacingPreset",
]);

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

function groupFinding(
  groups: Map<string, FindingGroup>,
  finding: ImportPreviewFinding,
  source?: string,
): void {
  const key = `${finding.category}:${finding.message}`;
  let group = groups.get(key);
  if (group === undefined) {
    group = {
      category: finding.category,
      message: finding.message,
      ...(finding.diagnostic === undefined ? {} : { diagnostic: finding.diagnostic }),
      ...(finding.warningCode === undefined ? {} : { warningCode: finding.warningCode }),
      sources: new Set(),
      notes: new Set(),
      contributions: new Map(),
      selectedSources: new Set(),
      selectedNotes: new Map(),
      noteOrder: new Set(),
      global: false,
      cached: undefined,
    };
    groups.set(key, group);
  }
  if (source === undefined) {
    group.global = true;
    for (const path of finding.sources) group.sources.add(path);
    for (const note of finding.notes) group.notes.add(note);
  } else if (!group.contributions.has(source)) group.contributions.set(source, finding.notes);
  for (const note of finding.notes) group.noteOrder.add(note);
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

/** Classifies all source and scan contributions once; later selection uses this retained index. */
export function prepareImportPreviewFindings(
  preview: InkImportPreview,
  selectedPaths?: ReadonlySet<string>,
  sourceNotes?: ReadonlyMap<string, ReadonlySet<string>>,
) {
  const groups = new Map<string, FindingGroup>();
  const sourceWarnings = new Set<string>();
  for (const source of preview.sources) {
    const notes = [
      ...(sourceNotes?.get(source.path) ??
        new Set(source.references.map((reference) => reference.notePath))),
    ];
    for (const [index, message] of source.warnings.entries()) {
      const warningCode = source.warningCodes?.[index];
      sourceWarnings.add(`${source.path}: ${message}`);
      groupFinding(
        groups,
        {
          category:
            warningCode === undefined
              ? category(message)
              : APPEARANCE_CODES.has(warningCode)
                ? "difference"
                : "warning",
          ...(warningCode === undefined ? {} : { warningCode }),
          message,
          sources: [source.path],
          notes,
        },
        source.path,
      );
    }
  }
  for (const finding of preview.scanFindings ?? []) {
    sourceWarnings.add(finding.original);
    groupFinding(groups, { ...finding, category: "skipped" });
  }
  for (const [index, message] of preview.warnings.entries()) {
    if (!sourceWarnings.has(message))
      groupFinding(
        groups,
        preview.truncated && index === preview.warnings.length - 1
          ? {
              category: "warning",
              message,
              sources: [],
              notes: [],
              diagnostic: { code: "scanTruncated" },
            }
          : scanFinding(message),
      );
  }
  return new PreparedImportPreviewFindings(groups, selectedPaths);
}

/** Compatibility entry point for callers that present the complete scan. */
export function buildImportPreviewFindings(
  preview: InkImportPreview,
): readonly ImportPreviewFinding[] {
  return prepareImportPreviewFindings(preview).findings;
}

class PreparedImportPreviewFindings {
  readonly #sources = new Map<string, FindingGroup[]>();
  #findings: readonly ImportPreviewFinding[] | undefined;

  public constructor(
    private readonly groups: ReadonlyMap<string, FindingGroup>,
    selectedPaths?: ReadonlySet<string>,
  ) {
    for (const group of groups.values()) {
      for (const source of group.contributions.keys()) {
        let affected = this.#sources.get(source);
        if (affected === undefined) {
          affected = [];
          this.#sources.set(source, affected);
        }
        affected.push(group);
        if (selectedPaths === undefined || selectedPaths.has(source))
          selectContribution(group, source, true);
      }
    }
  }

  public get findings(): readonly ImportPreviewFinding[] {
    if (this.#findings !== undefined) return this.#findings;
    const findings: ImportPreviewFinding[] = [];
    for (const group of this.groups.values()) {
      if (!group.global && group.selectedSources.size === 0) continue;
      group.cached ??= snapshotGroup(group);
      findings.push(group.cached);
    }
    this.#findings = findings;
    return findings;
  }

  public setSelected(source: string, selected: boolean): void {
    for (const group of this.#sources.get(source) ?? []) {
      if (group.selectedSources.has(source) === selected) continue;
      selectContribution(group, source, selected);
      group.cached = undefined;
      this.#findings = undefined;
    }
  }

  public setAllSelected(selected: boolean): void {
    for (const source of this.#sources.keys()) this.setSelected(source, selected);
  }
}

function selectContribution(group: FindingGroup, source: string, selected: boolean): void {
  if (selected) group.selectedSources.add(source);
  else group.selectedSources.delete(source);
  for (const note of group.contributions.get(source)!) {
    const count = (group.selectedNotes.get(note) ?? 0) + (selected ? 1 : -1);
    if (count === 0) group.selectedNotes.delete(note);
    else group.selectedNotes.set(note, count);
  }
}

function snapshotGroup(group: FindingGroup): ImportPreviewFinding {
  const sources = new Set<string>();
  for (const source of group.contributions.keys())
    if (group.selectedSources.has(source)) sources.add(source);
  for (const source of group.sources) sources.add(source);
  return {
    category: group.category,
    message: group.message,
    ...(group.diagnostic === undefined ? {} : { diagnostic: group.diagnostic }),
    ...(group.warningCode === undefined ? {} : { warningCode: group.warningCode }),
    sources: [...sources],
    notes: [...group.noteOrder].filter(
      (note) => group.selectedNotes.has(note) || group.notes.has(note),
    ),
  };
}
