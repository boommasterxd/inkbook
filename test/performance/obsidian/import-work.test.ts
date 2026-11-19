import { describe, expect, it, vi } from "vitest";

import { importFixture, writingEmbed } from "../../integration/obsidian/import/import-fixture";

function countEmbedSearches(note: string, embed: string) {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Observe searches of the imported note.
  const indexOf = String.prototype.indexOf;
  let count = 0;
  const searches = vi.spyOn(String.prototype, "indexOf").mockImplementation(function (
    this: string,
    needle: string,
    start?: number,
  ) {
    if (this === note && needle === embed) count++;
    return indexOf.call(this, needle, start);
  });
  return { count: () => count, restore: () => searches.mockRestore() };
}

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
    expect(fixture.reads.filter((path) => path === "Ink/example.inkbook.svg")).toHaveLength(3);
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
    const searches = countEmbedSearches(
      fixture.files.get("note.md")!,
      "![[Ink/example.inkbook.svg]]",
    );
    fixture.reads.length = 0;
    try {
      const restored = await fixture.service.undo(preview.id);
      expect(restored.journal.status).toBe("undone");
      expect(fixture.files.get("note.md")).toBe(original);
      // One forward scan of the current note covers all identical replacement texts.
      expect(searches.count()).toBeGreaterThan(0);
      expect(searches.count()).toBeLessThanOrEqual(1001);
      // Reconciliation, evidence and source restoration each take one vault snapshot.
      expect(listFiles.mock.calls.length).toBeLessThanOrEqual(3);
      // Evidence resolves before/after links; the restored note is resolved once more.
      expect(resolveLink.mock.calls.length).toBeLessThanOrEqual(3000);
      // Evidence, undo preparation and write readback each read the live note once.
      expect(fixture.reads.filter((path) => path === "note.md").length).toBeLessThanOrEqual(3);
    } finally {
      searches.restore();
      listFiles.mockRestore();
      resolveLink.mockRestore();
    }
  });
});

describe("Obsidian Ink note preparation", () => {
  it("visits each preview reference once when applying an import across many notes", async () => {
    const sourcePaths = Array.from({ length: 8 }, (_, index) => `Ink/source-${index}.svg`);
    const notes = Array.from({ length: 128 }, (_, index) => {
      const first = sourcePaths[index % sourcePaths.length]!;
      const second = sourcePaths[(index + 1) % sourcePaths.length]!;
      return { path: `note-${index}.md`, sources: [first, second] };
    });
    const fixture = importFixture({
      ...Object.fromEntries(sourcePaths.map((path) => [path, `Writing from ${path}`])),
      ...Object.fromEntries(
        notes.map(({ path, sources }) => [
          path,
          sources.map((source) => writingEmbed(source)).join("\n\n"),
        ]),
      ),
    });
    const preview = await fixture.service.scan();
    let visits = 0;
    let referenceCount = 0;
    for (const source of preview.sources) {
      for (const reference of source.references) {
        const { notePath } = reference;
        referenceCount++;
        Object.defineProperty(reference, "notePath", {
          get() {
            visits++;
            return notePath;
          },
        });
      }
    }

    const result = await fixture.service.apply(preview);

    expect(referenceCount).toBe(2 * notes.length);
    expect(visits).toBeGreaterThan(0);
    expect(visits).toBeLessThanOrEqual(referenceCount);
    expect(result.conflicts).toBe(0);
    expect(result.journal.notes).toHaveLength(notes.length);
    for (const { path, sources } of notes) {
      expect(fixture.files.get(path)).toBe(
        sources.map((source) => `![[${source.replace(/\.svg$/u, ".inkbook.svg")}]]`).join("\n\n"),
      );
    }
  });

  it("completes the cancelled journal without changing notes when reference preparation stops", async () => {
    const original = `${writingEmbed()}\n\n${writingEmbed()}`;
    const fixture = importFixture({ "Ink/example.svg": "writing source", "note.md": original });
    const preview = await fixture.service.scan();
    const controller = new AbortController();
    let checkpoints = 0;
    fixture.ports.workScheduler.checkpoint = (signal) => {
      if (signal !== controller.signal || ++checkpoints !== 2) return undefined;
      const reason = new DOMException("Import stopped.", "AbortError");
      controller.abort(reason);
      return Promise.reject(reason);
    };

    const result = await fixture.service.apply(preview, controller.signal);

    expect(result.journal.status).toBe("cancelled");
    expect(result.journal.notes).toEqual([]);
    expect(result.imported).toBe(1);
    expect(result.conflicts).toBe(0);
    expect(fixture.files.get("note.md")).toBe(original);
    expect((await fixture.service.history())[0]?.status).toBe("cancelled");
  });
});
