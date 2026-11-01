import { describe, expect, it } from "vitest";

import { appliedImportFixture, importFixture, writingEmbed } from "./import-fixture";

const referenced = "Cleanup skipped referenced or unverified source: Ink/example.svg";
const changed = "Cleanup skipped changed source or backup: Ink/example.svg";
const independent = "An unrelated import warning remains unresolved.";

async function appliedTwoSourceFixture() {
  const fixture = importFixture({
    "Ink/example.svg": "writing source",
    "other.svg": "other source",
    "note.md": `${writingEmbed()}\n${writingEmbed("other.svg")}`,
  });
  const preview = await fixture.service.scan();
  const { journal } = await fixture.service.apply(preview);
  return {
    ...fixture,
    preview,
    journal,
    journalPath: `inkbook-imports/${preview.id}/journal.json`,
  };
}

describe("Obsidian Ink cleanup feedback recovery", () => {
  it("refreshes retry reasons, repairs persisted duplicates, and clears resolved cleanup warnings", async () => {
    const fixture = await appliedTwoSourceFixture();
    const { preview, journal, journalPath } = fixture;
    fixture.files.set("another.md", "[ordinary reference](Ink/example.svg)");
    const partial = await fixture.service.cleanup(preview.id);
    expect(partial.journal.issues).toEqual([referenced]);
    expect(fixture.files.has("Ink/example.svg")).toBe(true);
    expect(fixture.files.has("other.svg")).toBe(false);

    journal.issues.push(independent, referenced, referenced);
    fixture.files.set(journalPath, JSON.stringify({ ...partial.journal, issues: journal.issues }));
    expect((await fixture.service.history())[0]?.issues).toEqual([independent, referenced]);
    const repeated = await fixture.service.cleanup(preview.id);
    expect(repeated.journal.issues).toEqual([independent, referenced]);
    expect(repeated.conflicts).toBe(2);

    fixture.files.set("Ink/example.svg", "User changed original");
    const newerReason = await fixture.service.cleanup(preview.id);
    expect(newerReason.journal.issues).toEqual([independent, changed]);
    fixture.files.set("Ink/example.svg", "writing source");
    fixture.files.delete("another.md");
    const successful = await fixture.service.cleanup(preview.id);
    expect(successful.journal.issues).toEqual([independent]);
    expect(successful.conflicts).toBe(1);
    expect(fixture.files.has("Ink/example.svg")).toBe(false);
    expect((await fixture.service.history())[0]?.issues).toEqual([independent]);
    const restored = await fixture.service.undo(preview.id);
    expect(restored.journal.status).toBe("undone");
    expect(restored.journal.issues).toEqual([independent]);
    expect(fixture.files.get("Ink/example.svg")).toBe("writing source");
    expect(fixture.files.get("other.svg")).toBe("other source");
    expect(fixture.files.get("note.md")).toBe(`${writingEmbed()}\n${writingEmbed("other.svg")}`);
  });

  it("retains skipped warnings on cancellation and clears them only when undo completes", async () => {
    const fixture = await appliedImportFixture();
    const importedNote = fixture.files.get("note.md")!;
    fixture.files.set("another.md", "[ordinary reference](Ink/example.svg)");
    const skipped = await fixture.service.cleanup(fixture.preview.id);
    skipped.journal.issues.push(independent);
    fixture.files.set(fixture.journalPath, JSON.stringify(skipped.journal));
    const cancelled = new AbortController();
    cancelled.abort();
    fixture.files.delete("another.md");
    const stopped = await fixture.service.cleanup(fixture.preview.id, cancelled.signal);
    expect(stopped.cancelled).toBe(true);
    expect(stopped.journal.issues).toEqual([referenced, independent]);
    expect(fixture.files.has("Ink/example.svg")).toBe(true);

    fixture.files.set("note.md", "User replaced the imported embed");
    const incomplete = await fixture.service.undo(fixture.preview.id);
    expect(incomplete.journal.status).toBe("conflict");
    expect(incomplete.journal.issues).toContain(referenced);
    fixture.files.set("note.md", importedNote);
    const completed = await fixture.service.undo(fixture.preview.id);
    expect(completed.journal.status).toBe("undone");
    expect(completed.journal.issues).toEqual([independent]);
    expect((await fixture.service.history())[0]?.issues).toEqual([independent]);
  });
});

describe("Obsidian Ink cleanup cancellation recovery", () => {
  it("preserves unvisited source reasons when Stop interrupts a partial retry", async () => {
    const fixture = await appliedTwoSourceFixture();
    const { preview } = fixture;
    fixture.files.set("references.md", "Ink/example.svg other.svg");
    const skipped = await fixture.service.cleanup(preview.id);
    expect(skipped.journal.issues).toHaveLength(2);
    fixture.files.delete("references.md");
    const controller = new AbortController();
    fixture.setFault((kind) => {
      if (kind === "trashed") controller.abort();
    });
    const stopped = await fixture.service.cleanup(preview.id, controller.signal);
    expect(stopped.cancelled).toBe(true);
    expect(stopped.journal.sources.map((source) => source.status)).toEqual(["cleaned", "created"]);
    expect(stopped.journal.issues).toEqual([
      "Cleanup skipped referenced or unverified source: other.svg",
    ]);
    fixture.setFault();
    expect((await fixture.service.cleanup(preview.id)).journal.issues).toEqual([]);
  });

  it("durably records removal failures before admitting another source", async () => {
    const fixture = await appliedTwoSourceFixture();
    const { preview } = fixture;
    let failed = false;
    const checkpoint = fixture.ports.workScheduler.checkpoint.bind(fixture.ports.workScheduler);
    fixture.ports.workScheduler.checkpoint = () => {
      if (failed) throw new Error("Interrupted before the next source");
      return undefined;
    };
    fixture.setFault((kind) => {
      if (kind === "trash") {
        failed = true;
        throw new Error("Removal failed");
      }
    });
    await expect(fixture.service.cleanup(preview.id)).rejects.toThrow("Interrupted before");
    fixture.ports.workScheduler.checkpoint = checkpoint;
    fixture.setFault();
    expect((await fixture.service.history())[0]?.issues).toEqual([
      "Cleanup read or removal failure: Ink/example.svg",
    ]);
    expect(fixture.files.has("Ink/example.svg")).toBe(true);
    expect(fixture.files.has("other.svg")).toBe(true);
    expect((await fixture.service.cleanup(preview.id)).journal.issues).toEqual([]);
  });
});
