import type { Editor, MarkdownFileInfo } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { PenTapInsertionController } from "../../../../src/obsidian/commands";

import { registerInsertion } from "./insertion-command-fixture";

function createHarness() {
  const setCursor = vi.fn();
  const editor = { setCursor } as unknown as Editor;
  const context = { file: { path: "note.md" } } as MarkdownFileInfo;
  const request = vi.fn(() => true);
  const command = registerInsertion({ canInsert: () => true, request });
  const check = vi.spyOn(command, "editorCheckCallback");
  const canInsertAtLine = vi.fn(() => true);
  const controller = new PenTapInsertionController({ canInsertAtLine }, () => true, command);
  const target = { context, editor, insideInkWidget: false, line: 3, sourcePath: "note.md" };
  const sample = {
    button: 0,
    buttons: 1,
    clientX: 10,
    clientY: 10,
    pointerId: 1,
    pointerType: "pen",
    timeStamp: 0,
  };
  return { canInsertAtLine, check, controller, request, sample, setCursor, target };
}

describe("pen tap command dispatch", () => {
  it("selects the tapped line and executes the registered editor command callback", () => {
    const { check, controller, request, sample, setCursor, target } = createHarness();
    expect(controller.begin(sample, target)).toBe(true);
    expect(controller.complete({ ...sample, buttons: 0, timeStamp: 100 })).toBe(true);
    expect(setCursor).toHaveBeenCalledWith({ line: 3, ch: 0 });
    expect(check).toHaveBeenCalledWith(false, target.editor, target.context);
    expect(request).toHaveBeenCalledWith(target.editor, "note.md");
    expect(setCursor.mock.invocationCallOrder[0]).toBeLessThan(
      check.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each(["note", "line"] as const)(
    "rejects a tap when its %s changes before completion",
    (change) => {
      const { canInsertAtLine, check, controller, sample, setCursor, target } = createHarness();
      expect(controller.begin(sample, target)).toBe(true);
      if (change === "note") Object.defineProperty(target.context, "file", { value: null });
      else canInsertAtLine.mockReturnValue(false);
      expect(controller.complete({ ...sample, buttons: 0, timeStamp: 100 })).toBe(false);
      expect(setCursor).not.toHaveBeenCalled();
      expect(check).not.toHaveBeenCalled();
    },
  );
});
