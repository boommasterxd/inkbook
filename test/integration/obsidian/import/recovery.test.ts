import { describe, expect, it } from "vitest";

import { inkImportReferenceState } from "../../../../src/obsidian/import/reference-state";
import { ObsidianInkImportService } from "../../../../src/obsidian/import/service";
import {
  appliedImportFixture,
  cleanedImportFixture,
  importFixture,
  writingEmbed,
} from "./import-fixture";

function basenameRestorationFixture(notePath: string) {
  const original = writingEmbed("example.svg");
  const fixture = importFixture({
    [notePath]: original,
    "A/example.svg": "original writing source",
    "B/example.svg": "other writing source",
  });
  fixture.ports.resolveLink = (link, sourcePath) => {
    if (fixture.files.has(link)) return link;
    const relative = `${sourcePath.slice(0, sourcePath.lastIndexOf("/") + 1)}${link}`;
    if (fixture.files.has(relative)) return relative;
    return [...fixture.files.keys()].find((path) => path.endsWith(`/${link}`));
  };
  fixture.ports.referenceState = (path) => inkImportReferenceState(fixture.ports, path);
  return { ...fixture, original };
}

describe("Obsidian Ink import persistence recovery", () => {
  it.each([
    ["create", "inkbook-imports/run-1/source-0.txt"],
    ["create", "Ink/example.inkbook.svg"],
    ["created", "Ink/example.inkbook.svg"],
    ["create", "inkbook-imports/run-1/note-0.md"],
    ["write", "note.md"],
    ["written", "note.md"],
  ])("preserves original content across %s failures at %s", async (boundary, target) => {
    const fixture = importFixture();
    const original = fixture.files.get("note.md");
    const preview = await fixture.service.scan();
    let failed = false;
    fixture.setFault((kind, path) => {
      if (!failed && kind === boundary && path === target) {
        failed = true;
        throw new Error("Injected I/O failure");
      }
    });
    await fixture.service.apply(preview);
    expect(failed).toBe(true);
    fixture.setFault();
    const recovered = new ObsidianInkImportService(fixture.ports);
    await recovered.history();
    await recovered.undo(preview.id);
    expect(fixture.files.get("Ink/example.svg")).toBe("writing source");
    expect(fixture.files.get("note.md")).toBe(original);
  });

  it("requires a verified durable journal intent before creating the native output", async () => {
    const fixture = importFixture();
    const preview = await fixture.service.scan();
    fixture.setFault((kind, path) => {
      if (kind !== "create" || path !== "Ink/example.inkbook.svg") return;
      const persisted = fixture.files.get("inkbook-imports/run-1/journal.json") ?? "";
      expect(persisted).toContain('"status":"intent"');
      expect(persisted).toContain('"targetPath":"Ink/example.inkbook.svg"');
      expect(fixture.files.get("inkbook-imports/run-1/source-0.txt")).toBe("writing source");
    });
    await fixture.service.apply(preview);
    const record = fixture.writes.findIndex((entry) => entry.path === "Ink/example.inkbook.svg");
    expect(
      fixture.writes.slice(0, record).some((entry) => entry.path.endsWith("journal.json")),
    ).toBe(true);
  });

  it("finishes the safe current source on cancellation and can undo the retained partial run", async () => {
    const fixture = importFixture();
    const controller = new AbortController();
    const preview = await fixture.service.scan();
    fixture.setFault((kind, path) => {
      if (kind === "created" && path === "Ink/example.inkbook.svg") controller.abort();
    });
    const result = await fixture.service.apply(preview, controller.signal);
    expect(result.cancelled).toBe(true);
    expect(result.journal.sources[0]?.status).toBe("created");
    expect(fixture.files.get("note.md")).toContain(writingEmbed());
    fixture.setFault();
    const history = await fixture.service.history();
    expect(history[0]?.status).toBe("cancelled");
    expect((await fixture.service.undo(preview.id)).journal.status).toBe("undone");
  });

  it("reconciles an interrupted cleanup and restores the verified original on undo", async () => {
    const fixture = importFixture();
    const preview = await fixture.service.scan();
    await fixture.service.apply(preview);
    fixture.setFault((kind) => {
      if (kind === "trashed") throw new Error("Host interrupted after trash");
    });
    await fixture.service.cleanup(preview.id);
    fixture.setFault();
    const history = await fixture.service.history();
    expect(history[0]?.sources[0]?.status).toBe("cleaned");
    await fixture.service.undo(preview.id);
    expect(fixture.files.get("Ink/example.svg")).toBe("writing source");
    expect(fixture.files.get("note.md")).toContain(writingEmbed());
  });

  it("retains an own embed if its cleaned original backup was changed", async () => {
    const { preview, ...fixture } = await cleanedImportFixture();
    fixture.files.set("inkbook-imports/run-1/source-0.txt", "changed backup");
    const result = await fixture.service.undo(preview.id);
    expect(result.journal.status).toBe("conflict");
    expect(fixture.files.get("note.md")).toContain("!");
    expect(fixture.files.has("Ink/example.svg")).toBe(false);
  });

  it("rejects a corrupted journal without changing vault content", async () => {
    const fixture = importFixture({
      "inkbook-imports/run-1/journal.json": '{"version":1,"id":"run-1","sources":[{}]}',
    });
    expect((await fixture.service.history())[0]?.unreadable).toBe(true);
    expect(fixture.writes).toEqual([]);
  });
});

describe("Obsidian Ink import source restoration", () => {
  it("restores a cleaned original when its basename link now resolves to another source", async () => {
    const fixture = basenameRestorationFixture("A/note.md");
    const preview = await fixture.service.scan();
    expect(preview.sources.map((source) => source.path)).toEqual(["A/example.svg"]);
    await fixture.service.apply(preview);
    const converted = fixture.files.get("A/example.inkbook.svg");
    expect(converted).toBeDefined();
    await fixture.service.cleanup(preview.id);
    expect(fixture.files.has("A/example.svg")).toBe(false);
    expect(fixture.ports.resolveLink("example.svg", "A/note.md")).toBe("B/example.svg");

    const result = await fixture.service.undo(preview.id);
    expect(result.journal.status).toBe("undone");
    expect(fixture.files.get("A/note.md")).toBe(fixture.original);
    expect(fixture.files.get("A/example.svg")).toBe("original writing source");
    expect(fixture.files.get("B/example.svg")).toBe("other writing source");
    expect(fixture.files.get("A/example.inkbook.svg")).toBe(converted);
  });

  it("retains the native embed when a new local source still owns the original basename link", async () => {
    const fixture = basenameRestorationFixture("C/note.md");
    const preview = await fixture.service.scan();
    expect(preview.sources.map((source) => source.path)).toEqual(["A/example.svg"]);
    await fixture.service.apply(preview);
    const imported = fixture.files.get("C/note.md");
    const converted = fixture.files.get("A/example.inkbook.svg");
    expect(imported).toBe("![[A/example.inkbook.svg]]");
    await fixture.service.cleanup(preview.id);
    expect(fixture.files.has("A/example.svg")).toBe(false);
    fixture.files.set("C/example.svg", "new local writing source");

    const result = await fixture.service.undo(preview.id);
    expect(result.journal.status).toBe("conflict");
    expect(fixture.files.get("A/example.svg")).toBe("original writing source");
    expect(fixture.ports.resolveLink("example.svg", "C/note.md")).toBe("C/example.svg");
    expect(fixture.files.get("C/note.md")).toBe(imported);
    expect(result.journal.issues).toContainEqual(
      expect.stringContaining(
        "C/note.md: Undo skipped embeds because an original link now points to a different file",
      ),
    );
    expect(fixture.files.get("C/example.svg")).toBe("new local writing source");
    expect(fixture.files.get("B/example.svg")).toBe("other writing source");
    expect(fixture.files.get("A/example.inkbook.svg")).toBe(converted);
  });
});

describe("Obsidian Ink import journal boundaries", () => {
  it("keeps valid imports recoverable beside unreadable or oversized history records", async () => {
    const fixture = importFixture();
    const preview = await fixture.service.scan();
    await fixture.service.apply(preview);
    fixture.files.set("inkbook-imports/broken/journal.json", "{bad json");
    fixture.files.set("inkbook-imports/oversized/journal.json", " ".repeat(16 * 1024 * 1024 + 1));
    const history = await fixture.service.history();
    expect(history.filter((entry) => entry.unreadable)).toHaveLength(2);
    expect(history.find((entry) => entry.id === preview.id)?.unreadable).toBeUndefined();
    expect(fixture.reads).not.toContain("inkbook-imports/oversized/journal.json");
    await fixture.service.undo(preview.id);
    expect(fixture.files.get("note.md")).toContain(writingEmbed());
  });
  it.each(["before", "empty-after", "source-extension", "target-folder", "backup-path"])(
    "rejects %s journal tampering without overwriting any original",
    async (change) => {
      const { preview, journal, journalPath, ...fixture } = await appliedImportFixture();
      const source = journal.sources[0];
      const patch = journal.notes[0]?.patches[0];
      if (source === undefined || patch === undefined)
        throw new Error("Missing imported fixture record");
      const modified = JSON.parse(JSON.stringify(journal)) as Record<string, unknown>;
      const sources = modified["sources"] as Record<string, unknown>[];
      const notes = modified["notes"] as { patches: Record<string, unknown>[] }[];
      if (change === "before" && notes[0]?.patches[0])
        notes[0].patches[0]["before"] = "corrupted replacement";
      if (change === "empty-after" && notes[0]?.patches[0]) notes[0].patches[0]["after"] = "";
      if (change === "source-extension" && sources[0]) sources[0]["path"] = "important.md";
      if (change === "target-folder" && sources[0])
        sources[0]["targetPath"] = "other/example.inkbook.svg";
      if (change === "backup-path" && sources[0])
        sources[0]["backupPath"] = "inkbook-imports/another/source-0.txt";
      fixture.files.set(journalPath, JSON.stringify(modified));
      const before = fixture.files.get("note.md");
      await expect(fixture.service.undo(preview.id)).rejects.toThrow();
      expect(fixture.files.get("note.md")).toBe(before);
      expect(fixture.files.get("Ink/example.svg")).toBe("writing source");
    },
  );

  it("retries a partial undo after a neighbouring source conflict is resolved", async () => {
    const original = `${writingEmbed("first.svg")}\n\n${writingEmbed("second.svg")}`;
    const fixture = importFixture({
      "first.svg": "first",
      "second.svg": "second",
      "note.md": original,
    });
    const preview = await fixture.service.scan();
    await fixture.service.apply(preview);
    fixture.files.set("first.svg", "Changed first");
    const partial = await fixture.service.undo(preview.id);
    expect(partial.journal.status).toBe("conflict");
    expect(partial.journal.issues).toContainEqual(
      expect.stringContaining(
        "note.md: Undo skipped embeds because an original file could not be safely restored",
      ),
    );
    expect((await fixture.service.undo(preview.id)).journal.issues).toEqual(partial.journal.issues);
    expect(fixture.files.get("note.md")).toContain("![[first.inkbook.svg]]");
    expect(fixture.files.get("note.md")).toContain(writingEmbed("second.svg"));
    fixture.files.set("first.svg", "first");
    const restored = await fixture.service.undo(preview.id);
    expect(restored.journal.status).toBe("undone");
    expect(restored.conflicts).toBe(0);
    expect(restored.journal.issues).toEqual([]);
    expect(fixture.files.get("note.md")).toBe(original);
  });
});
