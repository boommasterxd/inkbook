import { describe, expect, it } from "vitest";

import { inkImportReferenceState } from "../../../../src/obsidian/import/reference-state";
import { InkImportNoteBackupError } from "../../../../src/obsidian/import/note-backup-error";
import { appliedImportFixture, importFixture, writingEmbed } from "./import-fixture";

function aliasImportFixture(link = "example.svg") {
  const original = writingEmbed(link);
  const fixture = importFixture({
    "B/note.md": original,
    "A/example.svg": "selected writing source",
  });
  fixture.ports.resolveLink = (path, notePath) => {
    if (fixture.files.has(path)) return path;
    const relative = `${notePath.slice(0, notePath.lastIndexOf("/") + 1)}${path}`;
    if (fixture.files.has(relative)) return relative;
    return [...fixture.files.keys()].find((file) => file.endsWith(`/${path}`));
  };
  return { ...fixture, original };
}

async function mixedAliasImportFixture() {
  const fixture = aliasImportFixture();
  fixture.files.set("first.md", writingEmbed("A/example.svg"));
  fixture.files.set("other.svg", "independent writing source");
  fixture.files.set("other.md", writingEmbed("other.svg"));
  fixture.ports.referenceState = (path) => inkImportReferenceState(fixture.ports, path);
  const preview = await fixture.service.scan();
  fixture.files.set("B/example.svg", "new local writing source");
  const result = await fixture.service.apply(preview);
  return { ...fixture, preview, result };
}

function expectAliasFilesPreserved(fixture: ReturnType<typeof aliasImportFixture>): void {
  expect(fixture.files.get("B/note.md")).toBe(fixture.original);
  expect(fixture.files.get("B/example.svg")).toBe("new local writing source");
  expect(fixture.files.get("A/example.svg")).toBe("selected writing source");
  expect(fixture.files.get("A/example.inkbook.svg")).toBe(
    '<svg data-native="selected writing source"/>',
  );
}

describe("Obsidian Ink source alias conflicts", () => {
  it.each(["after preview", "during note backup"])(
    "preserves a basename reference whose resolved source changes %s",
    async (boundary) => {
      const fixture = aliasImportFixture();
      const preview = await fixture.service.scan();
      expect(preview.sources.map((source) => source.path)).toEqual(["A/example.svg"]);
      let noteWrites = 0;
      fixture.setFault((kind, path) => {
        if (kind === "write" && path === "B/note.md") noteWrites += 1;
        if (boundary === "during note backup" && kind === "created" && path.endsWith("note-0.md"))
          fixture.files.set("B/example.svg", "new local writing source");
      });
      if (boundary === "after preview")
        fixture.files.set("B/example.svg", "new local writing source");

      const result = await fixture.service.apply(preview);

      expectAliasFilesPreserved(fixture);
      expect(result.conflicts).toBeGreaterThan(0);
      expect(result.journal.notes[0]?.status).toBe("conflict");
      expect(noteWrites).toBe(0);
    },
  );

  it("imports an explicit source path despite a new local source with the same basename", async () => {
    const fixture = aliasImportFixture("A/example.svg");
    const preview = await fixture.service.scan();
    fixture.files.set("B/example.svg", "new local writing source");

    const result = await fixture.service.apply(preview);

    expect(result.conflicts).toBe(0);
    expect(fixture.files.get("B/note.md")).toBe("!inkbook[[A/example.inkbook.svg]]");
    expect(fixture.files.get("B/example.svg")).toBe("new local writing source");
    expect(fixture.files.get("A/example.svg")).toBe("selected writing source");
  });
});

describe("Obsidian Ink skipped alias conflict recovery", () => {
  it("undoes successful notes while preserving the untouched alias-conflict note", async () => {
    const fixture = await mixedAliasImportFixture();
    expect(fixture.result.journal.notes.map((note) => note.status)).toEqual([
      "conflict",
      "applied",
      "applied",
    ]);

    const result = await fixture.service.undo(fixture.preview.id);

    expect(result.journal.status).toBe("undone");
    expect(fixture.files.get("first.md")).toBe(writingEmbed("A/example.svg"));
    expect(fixture.files.get("other.md")).toBe(writingEmbed("other.svg"));
    expectAliasFilesPreserved(fixture);
    expect((await fixture.service.undo(fixture.preview.id)).journal.status).toBe("undone");
  });

  it("cleans an eligible imported original while retaining an original with a basename mention", async () => {
    const fixture = await mixedAliasImportFixture();

    const result = await fixture.service.cleanup(fixture.preview.id);

    expect(result.journal.sources.find((source) => source.path === "other.svg")?.status).toBe(
      "cleaned",
    );
    expect(fixture.files.has("other.svg")).toBe(false);
    expect(fixture.files.has("other.inkbook.svg")).toBe(true);
    expect(fixture.files.get("first.md")).toBe("!inkbook[[A/example.inkbook.svg]]");
    expectAliasFilesPreserved(fixture);
  });

  it("retains strict evidence checks when the skipped conflict note was subsequently edited", async () => {
    const fixture = await mixedAliasImportFixture();
    const edited = `${fixture.original}\nUser added a paragraph`;
    fixture.files.set("B/note.md", edited);

    await expect(fixture.service.undo(fixture.preview.id)).rejects.toThrow(
      "original writing reference",
    );

    expect(fixture.files.get("first.md")).toBe("!inkbook[[A/example.inkbook.svg]]");
    expect(fixture.files.get("B/note.md")).toBe(edited);
    expect(fixture.files.get("B/example.svg")).toBe("new local writing source");
  });
});

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
      const undo = fixture.service.undo(preview.id);
      if (change === "backup")
        await expect(undo).rejects.toMatchObject({
          name: "InkImportNoteBackupError",
          reason: "changed",
          notePath: "note.md",
          backupPath: "inkbook-imports/run-1/note-0.md",
        });
      else await expect(undo).rejects.toThrow();
      expect(fixture.files.get("note.md")).toBe(before);
    },
  );
});

describe("Obsidian Ink note backup access", () => {
  it.each(["undo", "cleanup"] as const)(
    "stops %s on an unreadable note backup and can retry after access is restored",
    async (operation) => {
      const fixture = await appliedImportFixture();
      const note = fixture.journal.notes[0]!;
      const before = new Map(fixture.files);
      fixture.writes.length = 0;
      fixture.setFault((kind, path) => {
        if (kind === "read" && path === note.backupPath)
          throw new Error("Private filesystem diagnostics");
      });
      await expect(fixture.service[operation](fixture.preview.id)).rejects.toBeInstanceOf(
        InkImportNoteBackupError,
      );
      expect(fixture.files).toEqual(before);
      expect(fixture.writes).toEqual([]);
      fixture.setFault();
      const restored = await fixture.service[operation](fixture.preview.id);
      expect(restored.conflicts).toBe(0);
      expect(
        operation === "undo" ? restored.journal.status : restored.journal.sources[0]?.status,
      ).toBe(operation === "undo" ? "undone" : "cleaned");
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
