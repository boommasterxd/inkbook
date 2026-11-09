import { describe, expect, it } from "vitest";

import { ObsidianInkImportService } from "../../../../src/obsidian/import/service";
import { cleanedImportFixture, importFixture, writingEmbed } from "./import-fixture";

describe("Obsidian Ink import workflow", () => {
  it("previews without writes and creates one collision-safe native source for every shared reference", async () => {
    const fixture = importFixture({
      "Ink/example.svg": "writing source",
      "Ink/example.inkbook.svg": "existing",
      "first.md": writingEmbed(),
      "second.md": writingEmbed("Ink/example.svg", "My transcript"),
    });
    const preview = await fixture.service.scan();
    expect(fixture.writes).toEqual([]);
    expect(preview.sources).toHaveLength(1);
    expect(preview.warnings).toContain("Ink/example.svg: Pressure approximated");
    expect(preview.notes["first.md"]).not.toBe(writingEmbed());
    const result = await fixture.service.apply(preview);
    expect(result.imported).toBe(1);
    expect(fixture.files.get("Ink/example.svg")).toBe("writing source");
    expect(fixture.files.get("Ink/example.inkbook.svg")).toBe("existing");
    expect(fixture.files.get("first.md")).toBe("![[Ink/example.inkbook-1.svg]]");
    expect(fixture.files.get("second.md")).toBe("![[Ink/example.inkbook-1.svg|My transcript]]");
    const count = fixture.writes.length;
    await fixture.service.apply(preview);
    expect(fixture.writes).toHaveLength(count);
    const journal = JSON.parse(
      fixture.files.get("inkbook-imports/run-1/journal.json") ?? "{}",
    ) as Record<string, unknown>;
    expect(JSON.stringify(journal)).not.toContain("writing source");
    expect(result.journal.sources[0]?.backupPath).toBe("inkbook-imports/run-1/source-0.txt");
  });

  it("skips invalid sources and references changed after preview", async () => {
    const fixture = importFixture({
      "bad.svg": "invalid",
      "Ink/example.svg": "valid",
      "bad.md": writingEmbed("bad.svg"),
      "changed.md": writingEmbed(),
      "source.md": writingEmbed(),
    });
    const preview = await fixture.service.scan();
    expect(preview.sources).toHaveLength(1);
    expect(preview.warnings).toContain("Unsupported or invalid writing source: bad.svg");
    fixture.files.set("changed.md", "User changed the note");
    fixture.files.set("Ink/example.svg", "User changed the source");
    const result = await fixture.service.apply(preview);
    expect(result.imported).toBe(0);
    expect(fixture.files.get("bad.md")).toBe(writingEmbed("bad.svg"));
    expect(fixture.files.get("changed.md")).toBe("User changed the note");
    expect(fixture.files.get("source.md")).toBe(writingEmbed());
  });
});

describe("Native Obsidian Ink replacement journals", () => {
  it("reads and undoes journals containing native replacement syntax", async () => {
    const original = writingEmbed();
    const fixture = importFixture({ "Ink/example.svg": "source", "note.md": original });
    fixture.ports.generateEmbed = (path) => `![[${path}]]`;
    const preview = await fixture.service.scan();
    await fixture.service.apply(preview);
    expect(fixture.files.get("note.md")).toBe("![[Ink/example.inkbook.svg]]");
    expect((await fixture.service.history())[0]?.status).toBe("complete");
    await new ObsidianInkImportService(fixture.ports).undo(preview.id);
    expect(fixture.files.get("note.md")).toBe(original);
  });
});

describe("Obsidian Ink import undo", () => {
  it("undoes only its own embeds while retaining independent note and generated-target edits", async () => {
    const original = `${"before ".repeat(30)}\n${writingEmbed()}\n${"after ".repeat(30)}`;
    const fixture = importFixture({ "Ink/example.svg": "source", "note.md": original });
    const preview = await fixture.service.scan();
    await fixture.service.apply(preview);
    fixture.files.set(
      "note.md",
      `New paragraph\n${fixture.files.get("note.md") ?? ""}\nNew footer`,
    );
    fixture.files.set("Ink/example.inkbook.svg", "User edited target");
    const result = await new ObsidianInkImportService(fixture.ports).undo(preview.id);
    expect(result.journal.status).toBe("undone");
    expect(fixture.files.get("note.md")).toBe(`New paragraph\n${original}\nNew footer`);
    expect(fixture.files.get("Ink/example.inkbook.svg")).toBe("User edited target");
    await fixture.service.undo(preview.id);
    expect(fixture.files.get("note.md")).not.toContain("![[Ink/example.inkbook.svg]]");
  });

  it("reports a durable per-note undo reason without repeating it or overwriting edited content", async () => {
    const notePath = "Archive: Undo review/note.md";
    const fixture = importFixture({
      "Ink/example.svg": "writing source",
      [notePath]: writingEmbed(),
      "restored.md": writingEmbed(),
    });
    const preview = await fixture.service.scan();
    await fixture.service.apply(preview);
    fixture.files.set(notePath, "User replaced the import with other content");
    const result = await fixture.service.undo(preview.id);
    expect(result.journal.status).toBe("conflict");
    expect(result.conflicts).toBe(1);
    expect(result.journal.notes.find((note) => note.path === "restored.md")?.status).toBe("undone");
    expect(result.journal.issues).toEqual([
      expect.stringContaining(
        `${notePath}: Undo skipped an imported embed that was changed, removed, or could not be uniquely identified`,
      ),
    ]);
    expect(fixture.files.get(notePath)).toBe("User replaced the import with other content");
    expect(fixture.files.get("restored.md")).toBe(writingEmbed());
    const repeated = await fixture.service.undo(preview.id);
    expect(repeated.conflicts).toBe(1);
    expect(repeated.journal.issues).toEqual(result.journal.issues);
    expect((await fixture.service.history())[0]?.issues).toEqual(result.journal.issues);
    expect(fixture.files.get(result.journal.notes[0]!.backupPath)).toBe(writingEmbed());
    fixture.files.set(notePath, "![[Ink/example.inkbook.svg]]");
    const resolved = await fixture.service.undo(preview.id);
    expect(resolved.journal.status).toBe("undone");
    expect(resolved.conflicts).toBe(0);
    expect(resolved.journal.issues).toEqual([]);
    expect(fixture.files.get(notePath)).toBe(writingEmbed());
    expect((await fixture.service.history())[0]?.issues).toEqual([]);
  });

  it("identifies the note when undo restores only its unchanged embed", async () => {
    const gap = `\n${"Unchanged paragraph. ".repeat(20)}\n`;
    const fixture = importFixture({
      "first.svg": "first source",
      "second.svg": "second source",
      "note.md": `${writingEmbed("first.svg")}${gap}${writingEmbed("second.svg")}`,
    });
    const preview = await fixture.service.scan();
    await fixture.service.apply(preview);
    fixture.files.set(
      "note.md",
      fixture.files.get("note.md")!.replace("![[first.inkbook.svg]]", "User replacement"),
    );
    const result = await fixture.service.undo(preview.id);
    expect(result.journal.status).toBe("conflict");
    expect(result.conflicts).toBe(1);
    expect(result.journal.notes[0]?.patches.map((patch) => patch.status)).toEqual([
      "applied",
      "undone",
    ]);
    expect(result.journal.issues).toEqual([
      expect.stringContaining("note.md: Undo skipped an imported embed"),
    ]);
    expect(fixture.files.get("note.md")).toBe(
      `User replacement${gap}${writingEmbed("second.svg")}`,
    );
    expect((await fixture.service.undo(preview.id)).journal.issues).toEqual(result.journal.issues);
  });

  it("reverses multiple nearby references from one note without context interference", async () => {
    const original = `${writingEmbed()}\n\n${writingEmbed()}`;
    const fixture = importFixture({ "Ink/example.svg": "source", "note.md": original });
    const preview = await fixture.service.scan();
    await fixture.service.apply(preview);
    await fixture.service.undo(preview.id);
    expect(fixture.files.get("note.md")).toBe(original);
  });
});

describe("Obsidian Ink import source cleanup", () => {
  it("cleans only verified imported originals and restores them from retained backups on undo", async () => {
    const fixture = importFixture();
    const preview = await fixture.service.scan();
    await fixture.service.apply(preview);
    await fixture.service.cleanup(preview.id);
    expect(fixture.files.has("Ink/example.svg")).toBe(false);
    expect(fixture.files.get("inkbook-imports/run-1/source-0.txt")).toBe("writing source");
    await fixture.service.undo(preview.id);
    expect(fixture.files.get("Ink/example.svg")).toBe("writing source");
    expect(fixture.files.get("note.md")).toContain(writingEmbed());
    expect(fixture.files.get("note.md")).not.toContain("![[Ink/example.inkbook.svg]]");
  });

  it("retains changed or still referenced originals during cleanup", async () => {
    const fixture = importFixture();
    const preview = await fixture.service.scan();
    await fixture.service.apply(preview);
    fixture.files.set("another.md", "[ordinary reference](Ink/example.svg)");
    await fixture.service.cleanup(preview.id);
    expect(fixture.files.has("Ink/example.svg")).toBe(true);
    fixture.files.delete("another.md");
    fixture.files.set("Ink/example.svg", "User changed original");
    await fixture.service.cleanup(preview.id);
    expect(fixture.files.get("Ink/example.svg")).toBe("User changed original");
    const cleanupIssues = (await fixture.service.history())[0]!.issues;
    expect(cleanupIssues).toEqual(["Cleanup skipped changed source or backup: Ink/example.svg"]);
    fixture.files.set("Ink/example.svg", "writing source");
    const restored = await fixture.service.undo(preview.id);
    expect(restored.journal.status).toBe("undone");
    expect(restored.journal.issues).toEqual([]);
  });

  it.each(["missing", "edited"])(
    "retains the original when the generated target is %s",
    async (state) => {
      const fixture = importFixture();
      const preview = await fixture.service.scan();
      await fixture.service.apply(preview);
      if (state === "missing") fixture.files.delete("Ink/example.inkbook.svg");
      else fixture.files.set("Ink/example.inkbook.svg", "User edited target");
      await fixture.service.cleanup(preview.id);
      expect(fixture.files.get("Ink/example.svg")).toBe("writing source");
    },
  );

  it("keeps own embeds when another file occupies a cleaned original path", async () => {
    const { preview, ...fixture } = await cleanedImportFixture();
    fixture.files.set("Ink/example.svg", "Different file");
    expect((await fixture.service.undo(preview.id)).journal.status).toBe("conflict");
    expect(fixture.files.get("note.md")).toContain("!");
    expect(fixture.files.get("Ink/example.svg")).toBe("Different file");
  });
});
