import { describe, expect, it, vi } from "vitest";

import { importFixture, writingEmbed } from "../../integration/obsidian/import/import-fixture";

describe("Obsidian Ink import work ownership", () => {
  it("converts, backs up and restores one canonical source across a thousand references", async () => {
    const original = Array.from(
      { length: 1000 },
      (_, index) => `Section ${index}\n\n${writingEmbed()}`,
    ).join("\n\n");
    const fixture = importFixture({
      "Ink/example.svg": "private source body",
      "note.md": original,
    });
    const preview = await fixture.service.scan();
    expect(preview.sources).toHaveLength(1);
    expect(preview.sources[0]?.references).toHaveLength(1000);
    expect(preview.notes["note.md"]).toMatch(/^[a-f\d]{64}$/u);
    expect(fixture.writes).toEqual([]);
    const applyListFiles = vi.spyOn(fixture.ports, "listFiles");
    const applyResolveLink = vi.spyOn(fixture.ports, "resolveLink");
    try {
      await fixture.service.apply(preview);
      // One note pass resolves every reference once; only run-history detection lists the vault.
      expect(applyResolveLink).toHaveBeenCalled();
      expect(applyResolveLink.mock.calls.length).toBeLessThanOrEqual(1000);
      expect(applyListFiles.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      applyListFiles.mockRestore();
      applyResolveLink.mockRestore();
    }
    expect(fixture.conversions).toEqual(["private source body", "private source body"]);
    expect(fixture.reads.filter((path) => path === "Ink/example.svg")).toHaveLength(5);
    expect(fixture.writes.filter((write) => write.path === "Ink/example.inkbook.svg")).toHaveLength(
      1,
    );
    expect(
      fixture.writes.filter((write) => write.path === "inkbook-imports/run-1/source-0.txt"),
    ).toHaveLength(1);
    expect(fixture.writes.filter((write) => write.path === "note.md")).toHaveLength(1);
    expect(fixture.files.get("note.md")?.match(/!/gu)).toHaveLength(1000);
    const journal = fixture.files.get("inkbook-imports/run-1/journal.json") ?? "";
    expect(journal).not.toContain("private source body");
    expect(fixture.files.get("Ink/example.svg")).toBe("private source body");
    const listFiles = vi.spyOn(fixture.ports, "listFiles");
    const resolveLink = vi.spyOn(fixture.ports, "resolveLink");
    fixture.reads.length = 0;
    try {
      const restored = await fixture.service.undo(preview.id);
      expect(restored.journal.status).toBe("undone");
      expect(fixture.files.get("note.md")).toBe(original);
      // Reconciliation, evidence and source restoration each take one vault snapshot.
      expect(listFiles.mock.calls.length).toBeLessThanOrEqual(3);
      // Evidence resolves before/after links; the restored note is resolved once more.
      expect(resolveLink.mock.calls.length).toBeLessThanOrEqual(3000);
      // Evidence, undo preparation and write readback each read the live note once.
      expect(fixture.reads.filter((path) => path === "note.md").length).toBeLessThanOrEqual(3);
    } finally {
      listFiles.mockRestore();
      resolveLink.mockRestore();
    }
  });
});
