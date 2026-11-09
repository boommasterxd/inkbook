import { describe, expect, it } from "vitest";

import { selectInkImportSources } from "../../../../src/obsidian/import/selection";
import { importFixture, writingEmbed } from "./import-fixture";

describe("Obsidian Ink import selection", () => {
  it("imports and undoes selected sources without visiting excluded sources or their exclusive notes", async () => {
    const selectedPath = "Ink/selected.svg";
    const excludedPath = "Ink/excluded.svg";
    const selectedEmbed = writingEmbed(selectedPath);
    const excludedEmbed = writingEmbed(excludedPath);
    const mixed = `Introduction\n\n${selectedEmbed}\n\n${excludedEmbed}\n\nConclusion`;
    const excludedNote = `Untouched\r\n\r\n${excludedEmbed}\r\n`;
    const fixture = importFixture({
      [selectedPath]: "selected source",
      [excludedPath]: "excluded source",
      "mixed.md": mixed,
      "excluded.md": excludedNote,
    });
    const preview = await fixture.service.scan();
    const selection = selectInkImportSources(preview, new Set([selectedPath, "missing.svg"]));
    expect(selection.sources).toHaveLength(1);
    expect(selection.sources[0]).toBe(
      preview.sources.find((source) => source.path === selectedPath),
    );
    expect(selection.notes).toEqual({ "mixed.md": preview.notes["mixed.md"] });
    expect(selection.id).toBe(preview.id);
    expect(selection.warnings).toBe(preview.warnings);
    expect(selection.truncated).toBe(preview.truncated);
    expect(preview.sources).toHaveLength(2);
    expect(Object.keys(preview.notes)).toEqual(expect.arrayContaining(["mixed.md", "excluded.md"]));
    fixture.reads.length = 0;
    const result = await fixture.service.apply(selection);
    expect(result.imported).toBe(1);
    expect(result.conflicts).toBe(0);
    expect(fixture.files.get("Ink/selected.inkbook.svg")).toBe(
      '<svg data-native="selected source"/>',
    );
    expect(fixture.files.get("mixed.md")).toBe(
      mixed.replace(selectedEmbed, "![[Ink/selected.inkbook.svg]]"),
    );
    expect(result.journal.sources.map((source) => source.path)).toEqual([selectedPath]);
    expect(result.journal.notes.map((note) => note.path)).toEqual(["mixed.md"]);
    expect([...fixture.files.keys()].filter((path) => path.includes("/source-"))).toEqual([
      "inkbook-imports/run-1/source-0.txt",
    ]);
    expect(fixture.files.get("inkbook-imports/run-1/source-0.txt")).toBe("selected source");
    const undone = await fixture.service.undo(selection.id);
    expect(undone.journal.status).toBe("undone");
    expect(fixture.files.get("mixed.md")).toBe(mixed);
    expect(fixture.files.get(excludedPath)).toBe("excluded source");
    expect(fixture.files.has("Ink/excluded.inkbook.svg")).toBe(false);
    expect(fixture.files.get("excluded.md")).toBe(excludedNote);
    expect(fixture.reads).not.toContain(excludedPath);
    expect(fixture.reads).not.toContain("excluded.md");
    expect(
      fixture.writes.some((write) => write.path === excludedPath || write.path === "excluded.md"),
    ).toBe(false);
  });

  it("returns no work for an empty or stale selection without touching the vault", async () => {
    const fixture = importFixture();
    const preview = await fixture.service.scan();
    fixture.reads.length = 0;
    for (const paths of [new Set<string>(), new Set(["missing.svg"])]) {
      const selection = selectInkImportSources(preview, paths);
      expect(selection.sources).toEqual([]);
      expect(selection.notes).toEqual({});
      expect(selection.id).toBe(preview.id);
    }
    expect(fixture.reads).toEqual([]);
    expect(fixture.writes).toEqual([]);
  });
});
