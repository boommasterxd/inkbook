import { describe, expect, it, vi } from "vitest";
import { importAdapterFixture, openNote } from "./adapter-fixture";
import { immediateWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";

describe("public Obsidian Ink import adapter", () => {
  it("reads current editor buffers and saves one bounded transaction before confirmation", async () => {
    const fixture = importAdapterFixture();
    fixture.put("note.md", "old disk");
    const open = openNote(fixture, "note.md", "before old after");
    expect(await fixture.ports.read("note.md")).toBe("before old after");
    expect(
      await fixture.ports.compareAndWrite("note.md", "before old after", "before new after"),
    ).toBe(true);
    expect(open.transaction).toHaveBeenCalledWith(
      { changes: [{ from: { line: 0, ch: 7 }, to: { line: 0, ch: 10 }, text: "new" }] },
      "inkbook-import",
    );
    expect(open.save).toHaveBeenCalledOnce();
    expect(fixture.text.get("note.md")).toBe("before new after");
    expect(await fixture.ports.compareAndWrite("note.md", "before old after", "outdated")).toBe(
      false,
    );
    expect(fixture.text.get("note.md")).toBe("before new after");
  });

  it("preserves divergent editors and an editor opened during a pending vault write", async () => {
    const fixture = importAdapterFixture();
    fixture.put("note.md", "original");
    openNote(fixture, "note.md", "first edit");
    openNote(fixture, "note.md", "second edit");
    await expect(fixture.ports.read("note.md")).rejects.toThrow("Conflicting open note buffers");
    expect(await fixture.ports.compareAndWrite("note.md", "first edit", "imported")).toBe(false);
    fixture.views.length = 0;
    fixture.processHook.mockImplementationOnce(() => {
      openNote(fixture, "note.md", "unsaved");
    });
    expect(await fixture.ports.compareAndWrite("note.md", "original", "imported")).toBe(false);
    expect(fixture.text.get("note.md")).toBe("original");
  });
});

describe("Ink import Markdown presentation modes", () => {
  it("imports and undoes Reading notes through the vault without saving stale editor buffers", async () => {
    const fixture = importAdapterFixture();
    fixture.put("note.md", "original");
    const reading = openNote(fixture, "note.md", "stale inactive buffer", "preview");
    expect(await fixture.ports.read("note.md")).toBe("original");
    expect(await fixture.ports.compareAndWrite("note.md", "original", "imported")).toBe(true);
    expect(await fixture.ports.read("note.md")).toBe("imported");
    expect(await fixture.ports.compareAndWrite("note.md", "imported", "original")).toBe(true);
    expect(fixture.text.get("note.md")).toBe("original");
    expect(reading.transaction).not.toHaveBeenCalled();
    expect(reading.save).not.toHaveBeenCalled();
  });

  it("uses active source buffers when Reading and source panes show the same note", async () => {
    const fixture = importAdapterFixture();
    fixture.put("note.md", "old disk");
    const reading = openNote(fixture, "note.md", "inactive", "preview");
    const source = openNote(fixture, "note.md", "unsaved source");
    expect(await fixture.ports.read("note.md")).toBe("unsaved source");
    expect(await fixture.ports.compareAndWrite("note.md", "unsaved source", "imported")).toBe(true);
    expect(fixture.text.get("note.md")).toBe("imported");
    expect(source.view.editor.getValue()).toBe("imported");
    expect(reading.transaction).not.toHaveBeenCalled();
    expect(reading.save).not.toHaveBeenCalled();
  });

  it.each(["mode", "file"] as const)(
    "preserves the note when the source %s changes during cooperative range preparation",
    async (change) => {
      const scheduler = immediateWorkScheduler();
      const fixture = importAdapterFixture(scheduler);
      const original = "a".repeat(5000);
      fixture.put("note.md", original);
      const other = fixture.put("other.md", original);
      const source = openNote(fixture, "note.md", original);
      scheduler.checkpoint = vi.fn().mockImplementationOnce(async () => {
        if (change === "mode") source.setMode("preview");
        else source.view.file = other;
      });
      expect(await fixture.ports.compareAndWrite("note.md", original, `${original}!`)).toBe(false);
      expect(fixture.text.get("note.md")).toBe(original);
      expect(source.transaction).not.toHaveBeenCalled();
      expect(source.save).not.toHaveBeenCalled();
    },
  );

  it("preserves Reading notes switched to source during the vault write", async () => {
    const fixture = importAdapterFixture();
    fixture.put("note.md", "original");
    const reading = openNote(fixture, "note.md", "unsaved source", "preview");
    fixture.processHook.mockImplementationOnce(() => reading.setMode("source"));
    expect(await fixture.ports.compareAndWrite("note.md", "original", "imported")).toBe(false);
    expect(fixture.text.get("note.md")).toBe("original");
    expect(reading.save).not.toHaveBeenCalled();
  });
});

describe("Ink import vault boundaries", () => {
  it("creates verified backups, generates native links, and rejects stale note versions", async () => {
    const fixture = importAdapterFixture();
    await fixture.ports.create("inkbook-imports/test-run/source-0.svg", "original");
    expect(await fixture.ports.read("inkbook-imports/test-run/source-0.svg")).toBe("original");
    expect(
      fixture.ports.generateEmbed("inkbook-imports/test-run/source-0.svg", "note.md", "Caption"),
    ).toBe("!inkbook[[inkbook-imports/test-run/source-0.svg|Caption]]");
    fixture.put("note.md", "independent edit");
    expect(await fixture.ports.compareAndWrite("note.md", "old", "imported")).toBe(false);
    expect(await fixture.ports.compareAndWrite("note.md", "independent edit", "imported")).toBe(
      true,
    );
    await expect(fixture.ports.create("note.md", "overwrite")).rejects.toThrow("exists");
  });

  it("checks the expected original again at the trash boundary and releases listeners", async () => {
    const fixture = importAdapterFixture();
    const source = fixture.put("source.svg", "new source");
    expect(await fixture.ports.trash("source.svg", "old source")).toBe(false);
    expect(fixture.trash).not.toHaveBeenCalled();
    fixture.readHook.mockImplementationOnce(() => {
      for (const listener of fixture.listeners) listener(source);
    });
    expect(await fixture.ports.trash("source.svg", "new source")).toBe(false);
    expect(fixture.listeners.size).toBe(0);
    expect(await fixture.ports.trash("source.svg", "new source")).toBe(true);
    expect(fixture.files.has("source.svg")).toBe(false);
  });

  it("protects extensionless links, unsaved references and uncertain content from cleanup", async () => {
    const fixture = importAdapterFixture();
    fixture.put("source.svg", "source");
    fixture.put("note.md", "[[source]]");
    expect(await fixture.ports.referenceState("source.svg")).toBe("referenced");
    fixture.put("note.md", "[attachment](source)");
    expect(await fixture.ports.referenceState("source.svg")).toBe("referenced");
    fixture.put("note.md", "no reference");
    const open = openNote(fixture, "note.md", "![x](source.svg)");
    expect(await fixture.ports.referenceState("source.svg")).toBe("referenced");
    open.setValue("no reference");
    expect(await fixture.ports.referenceState("source.svg")).toBe("unreferenced");
    fixture.put("board.canvas", '{"file":"source\\u002esvg"}');
    expect(await fixture.ports.referenceState("source.svg")).toBe("unknown");
    await expect(fixture.ports.trash("note.md", "no reference")).rejects.toThrow(
      "Close the original",
    );
  });
});
