import { expect, it } from "vitest";
import { importFixture, writingEmbed } from "./import-fixture";
import {
  MAX_IMPORT_PREVIEW_CHARS,
  MAX_IMPORT_REFERENCES,
  scanInkImports,
} from "../../../../src/obsidian/import/scan";

it("finds handwriting after a large unrelated note population without retaining unrelated content", async () => {
  const fixture = importFixture({});
  for (let index = 0; index < 10_001; index += 1)
    fixture.files.set(`notes/${index}.md`, "Unrelated note.");
  fixture.files.set("Ink/example.svg", "writing source");
  fixture.files.set("notes/handwriting.md", writingEmbed());
  const preview = await fixture.service.scan();
  expect(preview.sources.map((source) => source.path)).toEqual(["Ink/example.svg"]);
  expect(Object.keys(preview.notes)).toEqual(["notes/handwriting.md"]);
  expect(fixture.writes).toEqual([]);
  expect(preview.truncated).toBe(false);
});

it.each([
  { label: "finding count", link: "missing.svg", perNote: MAX_IMPORT_REFERENCES, notes: 2 },
  { label: "retained characters", link: `${"a".repeat(7_000)}.svg`, perNote: 2_000, notes: 3 },
])("bounds unresolved scan findings by $label", async ({ link, perNote, notes }) => {
  const fixture = importFixture({});
  const content = Array.from({ length: perNote }, () => writingEmbed(link)).join("\n\n");
  for (let index = 0; index < notes; index += 1) fixture.files.set(`notes/${index}.md`, content);
  const preview = await fixture.service.scan();
  const findings = preview.scanFindings!;
  const retained = findings.reduce(
    (total, finding) =>
      total +
      finding.original.length +
      finding.message.length +
      finding.sources.reduce((chars, path) => chars + path.length, 0) +
      finding.notes.reduce((chars, path) => chars + path.length, 0),
    0,
  );
  expect(findings.length).toBeGreaterThan(0);
  expect(findings.length).toBeLessThanOrEqual(MAX_IMPORT_REFERENCES);
  expect(findings.length).toBeLessThan(perNote * notes);
  expect(retained).toBeLessThanOrEqual(MAX_IMPORT_PREVIEW_CHARS);
  expect(preview.warnings.slice(0, -1)).toEqual(findings.map((finding) => finding.original));
  expect(preview.warnings[preview.warnings.length - 1]).toContain("bounded scan omitted files");
  expect(preview.truncated).toBe(true);
  expect(fixture.writes).toEqual([]);
});

it("retains structured skipped-item provenance without changing the original scan warnings", async () => {
  const first = "Notes: first.md";
  const second = "Notes: second.md";
  const fixture = importFixture({
    [first]: [
      writingEmbed("Ink: absent.svg"),
      writingEmbed("Ink: invalid.svg"),
      writingEmbed("Ink: missing.svg"),
    ].join("\n\n"),
    [second]: [
      writingEmbed("Ink: absent.svg"),
      writingEmbed("Ink: invalid.svg"),
      writingEmbed("Ink: missing.svg"),
    ].join("\n\n"),
    "Notes: unreadable.md": "Note cannot be read",
    "Ink: invalid.svg": "invalid",
  });
  fixture.setFault((kind, path) => {
    if (kind === "read" && path === "Notes: unreadable.md") throw new Error("Unavailable");
  });
  const preview = await scanInkImports({
    ...fixture.ports,
    resolveLink: (link, note) =>
      link === "Ink: missing.svg" ? link : fixture.ports.resolveLink(link, note),
  });
  expect(preview.scanFindings).toEqual([
    {
      original: `Unresolved writing reference in ${first}: Ink: absent.svg`,
      message: "Unresolved writing reference",
      sources: ["Ink: absent.svg"],
      notes: [first],
    },
    {
      original: "Missing source: Ink: missing.svg",
      message: "Missing source",
      sources: ["Ink: missing.svg"],
      notes: [first],
    },
    {
      original: `Unresolved writing reference in ${second}: Ink: absent.svg`,
      message: "Unresolved writing reference",
      sources: ["Ink: absent.svg"],
      notes: [second],
    },
    {
      original: "Missing source: Ink: missing.svg",
      message: "Missing source",
      sources: ["Ink: missing.svg"],
      notes: [second],
    },
    {
      original: "Could not inspect note: Notes: unreadable.md",
      message: "Could not inspect note",
      sources: [],
      notes: ["Notes: unreadable.md"],
    },
    {
      original: "Unsupported or invalid writing source: Ink: invalid.svg",
      message: "Unsupported or invalid writing source",
      sources: ["Ink: invalid.svg"],
      notes: [first, second],
    },
  ]);
  expect(preview.warnings).toEqual(preview.scanFindings?.map((finding) => finding.original));
  expect(fixture.writes).toEqual([]);
});
