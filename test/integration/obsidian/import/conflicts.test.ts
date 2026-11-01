import { describe, expect, it } from "vitest";

import { appliedImportFixture, importFixture, writingEmbed } from "./import-fixture";

describe("Obsidian Ink conflict and recovery boundaries", () => {
  it.each(["write", "written"])(
    "recovers an undo interrupted at the %s boundary",
    async (boundary) => {
      const fixture = importFixture();
      const preview = await fixture.service.scan();
      await fixture.service.apply(preview);
      let failed = false;
      fixture.setFault((kind, path) => {
        if (!failed && kind === boundary && path === "note.md") {
          failed = true;
          throw new Error("Interrupted undo");
        }
      });
      await fixture.service.undo(preview.id);
      fixture.setFault();
      await fixture.service.history();
      const result = await fixture.service.undo(preview.id);
      expect(result.journal.status).toBe("undone");
      expect(fixture.files.get("note.md")).toContain(writingEmbed());
    },
  );

  it("detects a changed source while the note write intent is being persisted", async () => {
    const fixture = importFixture();
    const preview = await fixture.service.scan();
    fixture.setFault((kind, path) => {
      if (kind === "created" && path.endsWith("note-0.md"))
        fixture.files.set("Ink/example.svg", "changed after backup");
    });
    const result = await fixture.service.apply(preview);
    expect(result.conflicts).toBeGreaterThan(0);
    expect(fixture.files.get("note.md")).toContain(writingEmbed());
  });

  it("retains sources modified during the final cleanup reference scan", async () => {
    const fixture = importFixture();
    const preview = await fixture.service.scan();
    await fixture.service.apply(preview);
    let checks = 0;
    fixture.ports.referenceState = () => {
      checks += 1;
      if (checks === 2) fixture.files.set("Ink/example.svg", "changed concurrently");
      return Promise.resolve("unreferenced");
    };
    await fixture.service.cleanup(preview.id);
    expect(fixture.files.get("Ink/example.svg")).toBe("changed concurrently");
    await fixture.service.history();
  });

  it.each(["backup", "imported-hash", "context"])(
    "rejects inconsistent %s evidence before undo",
    async (change) => {
      const { preview, journal, journalPath, ...fixture } = await appliedImportFixture();
      const modified = JSON.parse(JSON.stringify(journal)) as {
        notes: { importedHash: string; patches: { prefix: string }[] }[];
      };
      if (change === "backup")
        fixture.files.set("inkbook-imports/run-1/note-0.md", "changed note backup");
      if (change === "imported-hash" && modified.notes[0])
        modified.notes[0].importedHash = "different";
      if (change === "context" && modified.notes[0]?.patches[0])
        modified.notes[0].patches[0].prefix = "incorrect context";
      if (change !== "backup") fixture.files.set(journalPath, JSON.stringify(modified));
      const before = fixture.files.get("note.md");
      await expect(fixture.service.undo(preview.id)).rejects.toThrow();
      expect(fixture.files.get("note.md")).toBe(before);
    },
  );
});

describe("Obsidian Ink bounded scanning", () => {
  it("refuses to trash a non-writing backup despite matching forged journal digests", async () => {
    const fixture = importFixture();
    const preview = await fixture.service.scan();
    await fixture.service.apply(preview);
    const journalPath = "inkbook-imports/run-1/journal.json";
    const modified = JSON.parse(fixture.files.get(journalPath) ?? "{}") as {
      sources: { hash: string }[];
    };
    fixture.files.set("Ink/example.svg", "invalid");
    fixture.files.set("inkbook-imports/run-1/source-0.txt", "invalid");
    if (modified.sources[0] === undefined) throw new Error("Missing source fixture");
    modified.sources[0].hash = await fixture.ports.hash("invalid");
    fixture.files.set(journalPath, JSON.stringify(modified));
    await fixture.service.cleanup(preview.id);
    expect(fixture.conversions[fixture.conversions.length - 1]).toBe("invalid");
    expect(fixture.files.get("Ink/example.svg")).toBe("invalid");
    expect(fixture.writes.some((entry) => entry.kind === "trash")).toBe(false);
  });

  it("continues after unreadable notes or sources and reports each uncertainty", async () => {
    const fixture = importFixture({
      "broken.md": writingEmbed("bad.svg"),
      "bad.svg": "source",
      "note.md": writingEmbed(),
      "Ink/example.svg": "source",
    });
    fixture.setFault((kind, path) => {
      if (kind === "read" && (path === "broken.md" || path === "Ink/example.svg"))
        throw new Error("Cannot read");
    });
    const preview = await fixture.service.scan();
    expect(preview.sources).toEqual([]);
    expect(preview.warnings).toContain("Could not inspect note: broken.md");
    expect(preview.warnings).toContain("Unsupported or invalid writing source: Ink/example.svg");
    expect(fixture.writes).toEqual([]);
  });

  it("reports files beyond the read bound without reading them", async () => {
    const fixture = importFixture();
    const listFiles = fixture.ports.listFiles.bind(fixture.ports);
    fixture.ports.listFiles = () =>
      listFiles().map((file) => ({ ...file, size: 16 * 1024 * 1024 + 1 }));
    const preview = await fixture.service.scan();
    expect(preview.truncated).toBe(true);
    expect(preview.sources).toEqual([]);
    expect(fixture.reads).toEqual([]);
    expect(preview.warnings).toContain(
      "The bounded scan omitted files. Run another import after reviewing this batch.",
    );
  });
});
