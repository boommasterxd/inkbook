import { expect, it } from "vitest";

import type { InkImportPreview, InkImportSource } from "../../../../src/obsidian/import/types";
import { buildImportPreviewFindings } from "../../../../src/obsidian/settings/import/preview-findings";

const BRUSH = "Stroke outlines, smoothing and pressure response use Inkbook's native brush.";

function source(
  path: string,
  warnings: readonly string[],
  notes: readonly string[],
): InkImportSource {
  return {
    path,
    hash: "hash",
    targetPath: `${path}.inkbook.svg`,
    legacyWriting: false,
    warnings,
    references: notes.map((notePath) => ({
      notePath,
      sourcePath: path,
      start: 0,
      original: `![[${path}]]`,
    })),
  };
}

function preview(
  sources: readonly InkImportSource[],
  warnings: readonly string[] = [],
): InkImportPreview {
  return { id: "preview", sources, warnings, notes: {}, truncated: false };
}

it("groups shared appearance differences once with all exact source and reference paths", () => {
  const longPath = `${"folder/".repeat(100)}writing: original.svg`;
  const sources = [
    source(longPath, [BRUSH, BRUSH], ["A.md", "A.md", "B.md"]),
    source(`${longPath}: second.svg`, [BRUSH], ["B.md", "C.md"]),
  ];
  const warnings = sources.flatMap((item) => item.warnings.map((text) => `${item.path}: ${text}`));
  expect(buildImportPreviewFindings(preview(sources, warnings))).toEqual([
    {
      category: "difference",
      message: BRUSH,
      sources: sources.map((item) => item.path),
      notes: ["A.md", "B.md", "C.md"],
    },
  ]);
});

it("separates visual changes, metadata loss and skipped sources without losing unknown messages", () => {
  const metadata =
    "Stroke timing and source-specific metadata beyond creation time are not retained.";
  const transcript = "The source transcript remains in the original file and import backup.";
  const bindings = "Legacy arrow bindings were detached at their saved normalized anchors.";
  const stash =
    "Legacy files may omit strokes already missing from Ink's saved stash; those strokes cannot be recovered.";
  const unresolved = "Unresolved writing reference in Folder: note.md: Ink: missing.svg";
  const findings = buildImportPreviewFindings(
    preview(
      [
        source(
          "Ink/a.svg",
          [BRUSH, metadata, transcript, stash, bindings, "Unknown source warning"],
          ["A.md"],
        ),
      ],
      [
        "Missing source: Ink/missing.svg",
        "Missing source: Ink/other.svg",
        "Missing source: Ink/missing.svg",
        "Unsupported or invalid writing source: Ink/invalid.svg",
        "Could not inspect note: Folder: unreadable.md",
        unresolved,
        "Unknown scan warning",
        "Another unknown scan warning",
      ],
    ),
  );
  expect(
    findings
      .filter((finding) => finding.category === "difference")
      .map((finding) => finding.message),
  ).toEqual([BRUSH]);
  expect(
    findings.filter((finding) => finding.category === "warning").map((finding) => finding.message),
  ).toEqual([
    metadata,
    transcript,
    stash,
    bindings,
    "Unknown source warning",
    "Unknown scan warning",
    "Another unknown scan warning",
  ]);
  expect(findings.filter((finding) => finding.category === "skipped")).toEqual([
    {
      category: "skipped",
      message: "Missing source",
      sources: ["Ink/missing.svg", "Ink/other.svg"],
      notes: [],
    },
    {
      category: "skipped",
      message: "Unsupported or invalid writing source",
      sources: ["Ink/invalid.svg"],
      notes: [],
    },
    {
      category: "skipped",
      message: "Could not inspect note",
      sources: [],
      notes: ["Folder: unreadable.md"],
    },
    { category: "skipped", message: unresolved, sources: [], notes: [] },
  ]);
});

it("retains independent unprefixed warnings and returns no findings for a clean preview", () => {
  expect(buildImportPreviewFindings(preview([]))).toEqual([]);
  expect(
    buildImportPreviewFindings(
      preview([source("Ink/a.svg", ["Unknown"], ["A.md"])], ["Unknown", "Unknown"]),
    ),
  ).toEqual([{ category: "warning", message: "Unknown", sources: ["Ink/a.svg"], notes: ["A.md"] }]);
});

it("groups structured unresolved references across notes and preserves exact colon-containing paths", () => {
  const scanFindings = [
    { note: "Folder: A.md", link: "Ink: missing.svg" },
    { note: "Folder: B.md", link: "Ink: missing.svg" },
    { note: "Folder: A.md", link: "Ink: other.svg" },
  ].map(({ note, link }) => ({
    original: `Unresolved writing reference in ${note}: ${link}`,
    message: "Unresolved writing reference",
    sources: [link],
    notes: [note],
  }));
  expect(
    buildImportPreviewFindings({
      ...preview(
        [],
        scanFindings.map((finding) => finding.original),
      ),
      scanFindings,
    }),
  ).toEqual([
    {
      category: "skipped",
      message: "Unresolved writing reference",
      sources: ["Ink: missing.svg", "Ink: other.svg"],
      notes: ["Folder: A.md", "Folder: B.md"],
    },
  ]);
});
