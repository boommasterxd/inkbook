import { describe, expect, it, vi } from "vitest";

import { isCopiedEmbedPaste } from "../../../../src/obsidian/commands";
import { FILE_SCHEMA_LIMITS } from "../../../../src/domain/schema/public";
import {
  CLIPBOARD,
  SOURCE,
  FakeEditor,
  guardedRead,
  pasteHarness,
  pasteRequest,
} from "../../../fixtures/obsidian/embed-paste";

describe("copied Inkbook embed paste", () => {
  it("skips canonical validation only for an own confirmed source read", async () => {
    const matchesConfirmedOutput = vi.fn(() => true);
    const test = pasteHarness("reference", { matchesConfirmedOutput });

    await expect(test.controller.paste(pasteRequest(new FakeEditor()))).resolves.toEqual({
      kind: "inserted",
      mode: "reference",
    });
    expect(matchesConfirmedOutput).toHaveBeenCalledOnce();
    expect(test.validate).not.toHaveBeenCalled();
    expect(test.read).toHaveBeenCalledOnce();
  });

  it("validates changed source bytes when the own-output proof does not match", async () => {
    const matchesConfirmedOutput = vi.fn(() => false);
    const test = pasteHarness("duplicate", { matchesConfirmedOutput });
    test.read.mockResolvedValueOnce(guardedRead("drawings/source.svg", `${SOURCE}modified`));
    test.validate.mockResolvedValueOnce(false);

    await expect(test.controller.paste(pasteRequest(new FakeEditor()))).resolves.toEqual({
      kind: "inserted",
      mode: "original",
    });
    expect(test.validate).toHaveBeenCalledWith(`${SOURCE}modified`);
    expect(test.create).not.toHaveBeenCalled();
  });

  it("recognizes only one complete SVG embed outside an Inkbook widget", () => {
    expect(isCopiedEmbedPaste(CLIPBOARD, false)).toBe(true);
    expect(isCopiedEmbedPaste(`${CLIPBOARD}\n`, false)).toBe(false);
    expect(isCopiedEmbedPaste(`${CLIPBOARD}${CLIPBOARD}`, false)).toBe(false);
    expect(isCopiedEmbedPaste("![[drawing.png]]", false)).toBe(false);
    expect(isCopiedEmbedPaste(CLIPBOARD, true)).toBe(false);
  });

  it("validates the resolved source before inserting another reference", async () => {
    const editor = new FakeEditor("selected", 0, 8);
    const test = pasteHarness("reference");

    await expect(test.controller.paste(pasteRequest(editor))).resolves.toEqual({
      kind: "inserted",
      mode: "reference",
    });
    expect(editor.content).toBe(CLIPBOARD);
    expect(test.events).toEqual(["read:drawings/source.svg", `validate:${SOURCE}`, "choose"]);
    expect(test.create).not.toHaveBeenCalled();
    expect(test.read).toHaveBeenCalledOnce();
  });

  it("inserts the original Markdown without prompting when the SVG is not valid Inkbook data", async () => {
    const editor = new FakeEditor();
    const test = pasteHarness("duplicate");
    test.validate.mockResolvedValue(false);

    await expect(test.controller.paste(pasteRequest(editor))).resolves.toEqual({
      kind: "inserted",
      mode: "original",
    });
    expect(editor.content).toBe(CLIPBOARD);
    expect(test.choose).not.toHaveBeenCalled();
    expect(test.create).not.toHaveBeenCalled();
  });

  it("cancels without changing the editor or creating a file", async () => {
    const editor = new FakeEditor("selected", 0, 8);
    const test = pasteHarness(null);

    await expect(test.controller.paste(pasteRequest(editor))).resolves.toEqual({
      kind: "cancelled",
    });
    expect(editor.content).toBe("selected");
    expect(test.create).not.toHaveBeenCalled();
    expect(test.trash).not.toHaveBeenCalled();
  });
});

describe("duplicate insertion and editor ownership", () => {
  it.each(["choice", "placement"] as const)(
    "does not create a copy when the editor changes during %s",
    async (phase) => {
      const editor = new FakeEditor();
      const test = pasteHarness("duplicate");
      if (phase === "choice") {
        test.choose.mockImplementationOnce(async () => {
          editor.content = "user edit";
          return "duplicate";
        });
      } else {
        test.preparePath.mockImplementationOnce(async () => {
          editor.content = "user edit";
          return "drawings/duplicate.svg";
        });
      }

      await expect(test.controller.paste(pasteRequest(editor))).resolves.toEqual({
        cleanup: "not-needed",
        kind: "stale",
      });
      expect(test.create).not.toHaveBeenCalled();
      expect(test.trash).not.toHaveBeenCalled();
      expect(editor.content).toBe("user edit");
    },
  );

  it("creates and reads back an exact copy of the validated source before insertion", async () => {
    const editor = new FakeEditor();
    const test = pasteHarness("duplicate");
    const originalReplace = editor.replaceRange.bind(editor);
    editor.replaceRange = (replacement, from, to = from) => {
      test.events.push(`replace:${replacement}`);
      originalReplace(replacement, from, to);
    };

    await expect(test.controller.paste(pasteRequest(editor))).resolves.toEqual({
      kind: "inserted",
      mode: "duplicate",
    });
    expect(editor.content).toBe("!inkbook[[drawings/duplicate.svg]]");
    expect(test.events).toEqual([
      "read:drawings/source.svg",
      `validate:${SOURCE}`,
      "choose",
      "place",
      `create:drawings/duplicate.svg:${SOURCE}`,
      "read:drawings/duplicate.svg",
      "link:drawings/duplicate.svg",
      "replace:!inkbook[[drawings/duplicate.svg]]",
    ]);
  });

  it("moves a completed duplicate to recoverable trash when the editor became stale", async () => {
    const editor = new FakeEditor();
    const test = pasteHarness("duplicate");
    test.create.mockImplementation(async (path, content) => {
      editor.content = "user edit";
      return guardedRead(path, content);
    });

    await expect(test.controller.paste(pasteRequest(editor))).resolves.toEqual({
      cleanup: "trashed",
      kind: "stale",
    });
    expect(editor.content).toBe("user edit");
    expect(test.trash).toHaveBeenCalledWith("drawings/duplicate.svg");
  });

  it("does not trash an unrelated collision when Vault.create fails", async () => {
    const editor = new FakeEditor();
    const test = pasteHarness("duplicate");
    const collision = new Error("collision");
    test.create.mockRejectedValue(collision);

    await expect(test.controller.paste(pasteRequest(editor))).resolves.toEqual({
      error: collision,
      kind: "failed",
    });
    expect(test.trash).not.toHaveBeenCalled();
    expect(editor.content).toBe("");
  });
});

describe("atomic copied-embed duplicate read-back", () => {
  it("trashes a created file that fails exact read-back validation", async () => {
    const editor = new FakeEditor();
    const test = pasteHarness("duplicate");
    test.create.mockResolvedValueOnce(guardedRead("drawings/duplicate.svg", `${SOURCE}changed`));

    const outcome = await test.controller.paste(pasteRequest(editor));
    expect(outcome.kind).toBe("failed");
    expect(test.trash).toHaveBeenCalledWith("drawings/duplicate.svg");
    expect(editor.content).toBe("");
  });

  it("rejects a replacement identity returned by atomic create-and-read-back", async () => {
    const editor = new FakeEditor();
    const test = pasteHarness("duplicate");
    test.create.mockResolvedValueOnce(guardedRead("drawings/replaced.svg", SOURCE));

    await expect(test.controller.paste(pasteRequest(editor))).resolves.toMatchObject({
      kind: "failed",
    });
    expect(test.trash).toHaveBeenCalledWith("drawings/duplicate.svg");
    expect(editor.content).toBe("");
  });

  it("fails closed when atomic read-back rejects raced oversized content", async () => {
    const editor = new FakeEditor();
    const test = pasteHarness("duplicate");
    test.create.mockRejectedValueOnce(new Error("file-too-large"));

    await expect(test.controller.paste(pasteRequest(editor))).resolves.toMatchObject({
      kind: "failed",
    });
    expect(test.create).toHaveBeenCalledWith(
      "drawings/duplicate.svg",
      SOURCE,
      FILE_SCHEMA_LIMITS.totalInputBytes,
    );
    expect(test.trash).not.toHaveBeenCalled();
    expect(editor.content).toBe("");
  });
});
