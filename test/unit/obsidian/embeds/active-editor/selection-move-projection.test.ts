import { describe, expect, it, vi } from "vitest";
import { MovePreview } from "../../../../../src/obsidian/embeds/active-editor/previews/move-preview";
import type { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import type { PreparedElementHistory } from "../../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import type { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { ElementStore } from "../../../../../src/domain/store/public";
import { rectangle } from "../../../domain/store/fixtures";

const pointer = (x: number, y: number) => ({ pointerId: 10, pointerType: "mouse" as const, x, y });

describe("selection move edge-scroll projection", () => {
  it("reprojects the held viewport point after edge scrolling", () => {
    let refreshViewport: (() => void) | undefined;
    let scrollOffset = 0;
    let zoom = 1;
    const edgeDrag = {
      finish: vi.fn(),
      stop: vi.fn(),
      update: vi.fn(),
      updatePreviewBottom: vi.fn(),
      begin: vi.fn((refresh?: () => void) => {
        refreshViewport = refresh;
      }),
    };
    const setPreviewTransform = vi.fn();
    const setSelectionOverlayPath = vi.fn();
    const flushPointerFeedbackFrame = vi.fn();
    const element = rectangle(undefined, 0, 0);
    const preview = new MovePreview({
      history: {} as ActiveEditorHistory,
      pageToScreen: ({ x, y }) => ({ x: x * zoom, y: y * zoom }),
      pageToViewport: ({ x, y }) => ({ x: x * zoom, y: y * zoom - scrollOffset }),
      preparedHistory: {} as PreparedElementHistory,
      renderer: {
        clearPreviewTransforms: vi.fn(),
        flushPointerFeedbackFrame,
        setOverlayPath: vi.fn(),
        setPreviewTransform,
        setSelectionOverlayPath,
        suppressMotionForNextDelta: vi.fn(),
      },
      sceneStore: {} as ElementSceneStore,
      selection: () => new Set([element.id]),
      selectionEdgeDrag: edgeDrag,
      setSelection: vi.fn(),
      start: {
        additive: false,
        kind: "element-move",
        pointer: pointer(10, 20),
        tool: "select",
      },
      store: new ElementStore([element]),
      viewportToPage: ({ x, y }) => ({ x: x / zoom, y: (y + scrollOffset) / zoom }),
      zoom: () => zoom,
    });

    preview.update(pointer(30, 50));
    expect(setPreviewTransform.mock.lastCall?.slice(0, 3)).toEqual([
      [element.id],
      "translate(20 30)",
      1,
    ]);
    refreshViewport?.();
    refreshViewport?.();
    expect(setPreviewTransform).toHaveBeenCalledOnce();
    expect(flushPointerFeedbackFrame).toHaveBeenCalledOnce();

    scrollOffset = 40;
    refreshViewport?.();

    expect(setPreviewTransform.mock.lastCall?.slice(0, 3)).toEqual([
      [element.id],
      "translate(20 70)",
      2,
    ]);
    // The rotation handle stays 28 screen pixels above the translated top edge.
    expect(setSelectionOverlayPath.mock.lastCall?.[2]).toContain("M 115 42 a ");
    expect(flushPointerFeedbackFrame).toHaveBeenCalledTimes(2);
    refreshViewport?.();
    expect(setPreviewTransform).toHaveBeenCalledTimes(2);
    expect(flushPointerFeedbackFrame).toHaveBeenCalledTimes(2);
    zoom = 2;
    refreshViewport?.();
    expect(setPreviewTransform).toHaveBeenCalledTimes(3);
    expect(setPreviewTransform.mock.lastCall?.[1]).toBe("translate(5 25)");
    expect(setSelectionOverlayPath.mock.lastCall?.[2]).toContain("M 205 22 a ");
    expect(flushPointerFeedbackFrame).toHaveBeenCalledTimes(3);
    preview.revert();
    refreshViewport?.();
    expect(setPreviewTransform).toHaveBeenCalledTimes(3);
  });
});
