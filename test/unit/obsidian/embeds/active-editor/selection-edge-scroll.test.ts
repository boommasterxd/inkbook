import { describe, expect, it, vi } from "vitest";

import {
  SelectionEdgeAutoScroller,
  type SelectionEdgeAutoScrollerOptions,
} from "../../../../../src/obsidian/embeds/active-editor/selection-edge-scroll";
import { ActiveEditorSelectionEdgeDrag } from "../../../../../src/obsidian/embeds/active-editor/controller-selection-edge";
import { MovePreview } from "../../../../../src/obsidian/embeds/active-editor/move-preview";
import type { SelectionPreviewOptions } from "../../../../../src/obsidian/embeds/active-editor/selection-preview-contracts";
import type { ActiveEditorNavigation } from "../../../../../src/obsidian/embeds/active-editor/navigation";
import type { BrowserScrollElement } from "../../../../../src/obsidian/scrolling/index";

class Frames {
  readonly callbacks = new Map<number, FrameRequestCallback>();
  #next = 1;

  readonly cancel = (frame: number): void => {
    this.callbacks.delete(frame);
  };

  readonly request = (callback: FrameRequestCallback): number => {
    const frame = this.#next++;
    this.callbacks.set(frame, callback);
    return frame;
  };

  flush(timestamp = 0): void {
    const entry = this.callbacks.entries().next().value;
    if (entry === undefined) throw new Error("No frame is pending.");
    this.callbacks.delete(entry[0]);
    entry[1](timestamp);
  }
}

function createScroller(
  frames: Frames,
  options: Pick<SelectionEdgeAutoScrollerOptions, "onFrame" | "onScroll">,
): SelectionEdgeAutoScroller {
  return new SelectionEdgeAutoScroller({
    cancelFrame: frames.cancel,
    readViewport: () => ({ bottom: 500, left: 100, right: 900, top: 100 }),
    requestFrame: frames.request,
    ...options,
  });
}

describe("selection edge auto-scroll", () => {
  it("scrolls continuously while the held pointer remains inside an edge zone", () => {
    const frames = new Frames();
    const onScroll = vi.fn();
    const scroller = createScroller(frames, {
      onScroll,
    });

    scroller.update({ x: 500, y: 490 });
    frames.flush();
    const firstDelta = onScroll.mock.calls[0]?.[0] as { readonly x: number; readonly y: number };
    expect(firstDelta.x).toBe(0);
    expect(firstDelta.y).toBeGreaterThan(0);
    expect(frames.callbacks.size).toBe(1);

    scroller.update({ x: 500, y: 300 });
    frames.flush();
    expect(frames.callbacks.size).toBe(0);
  });

  it("bounds frame speed and cancels scheduled work when the drag ends", () => {
    const frames = new Frames();
    const onScroll = vi.fn();
    const scroller = createScroller(frames, {
      onScroll,
    });

    scroller.update({ x: 2_000, y: 2_000 });
    frames.flush();
    expect(onScroll).toHaveBeenCalledWith({ x: 16, y: 16 });
    scroller.finish();
    expect(frames.callbacks.size).toBe(0);
  });

  it("refreshes the held pointer before applying the next scroll step", () => {
    const frames = new Frames();
    const calls: string[] = [];
    const scroller = createScroller(frames, {
      onFrame: () => calls.push("refresh"),
      onScroll: () => calls.push("scroll"),
    });

    scroller.update({ x: 500, y: 490 });
    frames.flush();

    expect(calls).toEqual(["refresh", "scroll"]);
    scroller.finish();
  });

  it("keeps edge-scroll distance stable across refresh rates", () => {
    expect(scrollDistanceOverOneSecond(60)).toBeCloseTo(scrollDistanceOverOneSecond(240), 8);
  });
});

function scrollDistanceOverOneSecond(refreshRate: number): number {
  const frames = new Frames();
  let distance = 0;
  const scroller = createScroller(frames, {
    onScroll: ({ y }) => {
      distance += y;
    },
  });
  scroller.update({ x: 500, y: 490 });
  frames.flush(0);
  for (let frame = 1; frame <= refreshRate; frame += 1) {
    frames.flush((frame * 1_000) / refreshRate);
  }
  scroller.finish();
  return distance;
}

describe("active editor selection edge integration", () => {
  it("keeps pointer reprojection and native navigation in one drag session", () => {
    const frames = new Frames();
    const pan = vi.fn();
    const scroll = vi.fn();
    const navigation = { pan, scroll } as unknown as ActiveEditorNavigation;
    const owner = {
      clientHeight: 400,
      clientWidth: 800,
      getBoundingClientRect: () => ({ bottom: 500, height: 400, left: 100, right: 900, top: 100 }),
      ownerDocument: { scrollingElement: null },
    } as unknown as BrowserScrollElement;
    const drag = new ActiveEditorSelectionEdgeDrag({
      layout: {
        begin: vi.fn(),
        finish: vi.fn(),
        updateBottom: vi.fn(),
      },
      navigation,
      ownerWindow: {
        cancelAnimationFrame: frames.cancel,
        innerHeight: 600,
        innerWidth: 1_000,
        requestAnimationFrame: frames.request,
      } as unknown as Window,
      scrollOwner: () => owner,
    });

    const refreshViewport = vi.fn();
    drag.begin(refreshViewport);
    drag.update({ x: 910, y: 510 });
    frames.flush();
    expect(refreshViewport).toHaveBeenCalledOnce();
    expect(pan.mock.calls[0]?.[0]).toBeLessThan(0);
    expect(scroll.mock.calls[0]?.[0]).toBeLessThan(0);
    drag.finish(false);
    expect(frames.callbacks.size).toBe(0);
  });
});

describe("selection edge-scroll frame arbitration", () => {
  it.each([300, 110])("uses the latest pointer at y=%s when scrolling runs first", (y) => {
    const frames = new Frames();
    const onScroll = vi.fn<SelectionEdgeAutoScrollerOptions["onScroll"]>();
    let refresh: (() => void) | undefined;
    const scroller = createScroller(frames, { onFrame: () => refresh?.(), onScroll });
    const setPreviewTransform = vi.fn();
    const preview = new MovePreview({
      history: {} as SelectionPreviewOptions["history"],
      preparedHistory: {} as SelectionPreviewOptions["preparedHistory"],
      sceneStore: {} as SelectionPreviewOptions["sceneStore"],
      store: {} as SelectionPreviewOptions["store"],
      setSelection: vi.fn(),
      frameScheduler: {
        cancelAnimationFrame: frames.cancel,
        requestAnimationFrame: frames.request,
      },
      pageToScreen: (point) => point,
      viewportToPage: (point) => point,
      renderer: {
        setPreviewTransform,
        setOverlayPath: vi.fn(),
        clearPreviewTransforms: vi.fn(),
        suppressMotionForNextDelta: vi.fn(),
      },
      selection: () => new Set(),
      selectionEdgeDrag: {
        begin: (callback) => {
          refresh = callback;
        },
        finish: () => scroller.finish(),
        stop: () => scroller.finish(),
        update: (point) => scroller.update(point),
        updatePreviewBottom: vi.fn(),
      },
      start: {
        additive: false,
        kind: "element-move",
        tool: "select",
        pointer: { pointerId: 1, pointerType: "pen", x: 500, y: 300 },
      },
    });
    preview.update({ pointerId: 1, pointerType: "pen", x: 500, y: 490 });
    frames.flush();
    frames.flush();
    expect(onScroll.mock.lastCall?.[0].y).toBeGreaterThan(0);
    expect(frames.callbacks.size).toBe(1);

    preview.update({ pointerId: 1, pointerType: "pen", x: 500, y });
    expect(frames.callbacks.size).toBe(2);
    frames.flush();
    expect(setPreviewTransform).toHaveBeenLastCalledWith([], `translate(0 ${String(y - 300)})`, 3);
    if (y === 300) {
      expect(onScroll).toHaveBeenCalledOnce();
      expect(frames.callbacks.size).toBe(0);
    } else {
      expect(onScroll.mock.lastCall?.[0].y).toBeLessThan(0);
      expect(frames.callbacks.size).toBe(1);
    }
    preview.revert();
    expect(frames.callbacks.size).toBe(0);
  });
});
