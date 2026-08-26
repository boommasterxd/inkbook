import { describe, expect, it } from "vitest";

import { createInputState } from "../../../../../src/editor/input/index";
import {
  touchInteractionBlocksNativeScroll,
  touchPanDelta,
} from "../../../../../src/obsidian/embeds/active-editor/controller-touch";

describe("active editor touch routing", () => {
  it("increases horizontal camera response without changing direction", () => {
    expect(touchPanDelta(10)).toBe(12);
    expect(touchPanDelta(-10)).toBe(-12);
  });

  it("leaves pending and vertical touches native but blocks claimed gestures", () => {
    const base = touchInteraction();

    expect(touchInteractionBlocksNativeScroll({ ...base, phase: "touch-pending" })).toBe(false);
    expect(touchInteractionBlocksNativeScroll({ ...base, phase: "note-scroll" })).toBe(false);
    expect(touchInteractionBlocksNativeScroll({ ...base, phase: "page-pan" })).toBe(true);
    expect(
      touchInteractionBlocksNativeScroll({ ...base, phase: "element-move", elementId: "shape-a" }),
    ).toBe(true);
    expect(
      touchInteractionBlocksNativeScroll({
        ...base,
        phase: "element-move",
        elementId: "shape-a",
        previewStarted: true,
      }),
    ).toBe(true);
    expect(touchInteractionBlocksNativeScroll(undefined)).toBe(false);
    expect(
      touchInteractionBlocksNativeScroll({ ...base, phase: "tool-gesture", pointerType: "pen" }),
    ).toBe(false);
  });
});

function touchInteraction() {
  return {
    current: { x: 20, y: 30 },
    longPressScheduled: false,
    penRole: "normal" as const,
    phase: "touch-pending" as const,
    pointerId: 7,
    pointerType: "touch" as const,
    previewStarted: false,
    previousTool: createInputState().activeTool,
    shift: false,
    start: { x: 10, y: 30 },
    temporaryEraser: false,
    tool: createInputState().activeTool,
  };
}
