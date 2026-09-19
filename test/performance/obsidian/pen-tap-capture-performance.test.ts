// @vitest-environment happy-dom

import { expect, it } from "vitest";

import { createHtmlElement } from "../../adapters/obsidian/dom";
import { mountCountedPenTapEditor, penEvent } from "../../fixtures/obsidian/pen-tap-extension";

it.for(["touch", "widget", "padding"])("keeps %s pointer capture bounded", (surface) => {
  const editor = mountCountedPenTapEditor();
  const widget = createHtmlElement("div");
  widget.className = "inkbook-root";
  editor.view.contentDOM.append(widget);
  const target = surface === "widget" ? widget : editor.view.scrollDOM;
  const pointerType = surface === "touch" ? "touch" : "pen";

  try {
    for (let sample = 0; sample < 2; sample += 1) {
      const down = penEvent("pointerdown", { pointerType });
      const up = penEvent("pointerup", { pointerType });
      const click = penEvent("click", { pointerType });

      target.dispatchEvent(down);
      target.dispatchEvent(up);
      target.dispatchEvent(click);
    }

    if (surface === "padding") {
      const attempts = 2;
      expect(editor.counts.command).toBe(attempts);
      expect(editor.counts.posAtCoords).toBe(attempts);
      // Validate once on pointerdown and revalidate once before insertion on pointerup.
      expect(editor.counts.canInsertAtLine).toBe(attempts * 2);
      expect(editor.counts.setCursor).toBe(attempts);
    } else {
      expect(editor.counts.posAtCoords).toBe(0);
      expect(editor.counts.command).toBe(0);
    }
  } finally {
    editor.destroy();
  }
});
