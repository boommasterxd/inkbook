// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActiveEditorController } from "../../../../src/obsidian/embeds/active-editor/controller";
import type { SynchronousClipboardData } from "../../../../src/obsidian/embeds/active-editor/clipboard-reader";
import { attachActiveSceneInputListeners } from "../../../../src/obsidian/embeds/active-scene-input";
import type { SvgSceneRenderer } from "../../../../src/rendering/scene/index";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

beforeEach(installObsidianDomHelpers);

describe("active scene input boundary", () => {
  it("keeps keyboard ownership across the complete embed and its toolbar", () => {
    const boundary = document.body.createDiv();
    const inputSurface = boundary.createDiv();
    const toolbar = boundary.createEl("button");
    const handlePointerBoundary = vi.fn();
    const controller = controllerPort(handlePointerBoundary);
    const remove = attachActiveSceneInputListeners(
      { inputSurface } as unknown as SvgSceneRenderer,
      controller,
      boundary,
    );

    boundary.dispatchEvent(new Event("pointerenter"));
    toolbar.dispatchEvent(new Event("pointerenter"));
    boundary.dispatchEvent(new Event("pointerleave"));

    expect(handlePointerBoundary.mock.calls).toEqual([[true], [false]]);
    remove();
    boundary.dispatchEvent(new Event("pointerenter"));
    expect(handlePointerBoundary).toHaveBeenCalledTimes(2);
    boundary.remove();
  });

  it("marks a native Paste event from the focused canvas as surface-owned", () => {
    const boundary = document.body.createDiv();
    const inputSurface = boundary.createDiv();
    const data = { getData: vi.fn(), types: [] };
    const handlePaste = vi.fn(() => true);
    const remove = attachActiveSceneInputListeners(
      { inputSurface } as unknown as SvgSceneRenderer,
      controllerPort(vi.fn(), handlePaste),
      boundary,
    );
    const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", { value: data });

    inputSurface.dispatchEvent(event);

    expect(handlePaste).toHaveBeenCalledWith(data, true);
    expect(event.defaultPrevented).toBe(true);
    remove();
    boundary.remove();
  });
});

function controllerPort(
  handlePointerBoundary: (pointerOver: boolean) => void,
  handlePaste: (data: SynchronousClipboardData | null, surfaceOwned?: boolean) => boolean = () =>
    false,
): ActiveEditorController {
  return {
    blocksNativeTouchScrolling: () => false,
    handleDocumentKeyDown: () => false,
    handleLostPointerCapture: vi.fn(),
    handlePaste,
    handlePointerBoundary,
    handlePointerCancel: vi.fn(),
    handlePointerDown: vi.fn(),
    handlePointerMove: vi.fn(),
    handlePointerUp: vi.fn(),
    preparePrimaryTouchStart: vi.fn(),
    recoverInterruptedTouch: vi.fn(),
    recoverTouchTerminal: vi.fn(),
  } as unknown as ActiveEditorController;
}
