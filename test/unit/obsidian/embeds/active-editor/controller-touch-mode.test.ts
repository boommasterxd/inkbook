// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { ActiveEditorTouchMode } from "../../../../../src/obsidian/embeds/active-editor/controller-touch-mode";
import { createInputState } from "../../../../../src/editor/input/index";

describe("active editor touch mode", () => {
  it("keeps native vertical panning unless finger drawing is available and enabled", () => {
    const surface = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    const mode = new ActiveEditorTouchMode(surface, true);

    expect(surface.style.touchAction).toBe("pan-y");
    const input = mode.toggle(createInputState({ deviceFingerDrawingEnabled: true }));
    expect(input.toolbarFingerDrawingEnabled).toBe(true);
    expect(surface.style.touchAction).toBe("none");

    expect(mode.updateAvailable(false)).toBe(true);
    expect(surface.style.touchAction).toBe("pan-y");
    expect(mode.updateAvailable(false)).toBe(false);
  });
});
