import { describe, expect, it, vi } from "vitest";

import { SelectionEdgeAutoScroller } from "../../../../../src/obsidian/embeds/active-editor/selection-edge-scroll";
import { ActiveEditorSelectionEdgeDrag } from "../../../../../src/obsidian/embeds/active-editor/controller-selection-edge";
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

  flush(): void {
    const entry = this.callbacks.entries().next().value;
    if (entry === undefined) throw new Error("No frame is pending.");
    this.callbacks.delete(entry[0]);
    entry[1](0);
  }
}

describe("selection edge auto-scroll", () => {
  it("scrolls continuously inside the edge zone and reports the bottom edge", () => {
    const frames = new Frames();
    const onBottomEdge = vi.fn();
    const onScroll = vi.fn();
    const scroller = new SelectionEdgeAutoScroller({
      cancelFrame: frames.cancel,
      onBottomEdge,
      onScroll,
      readViewport: () => ({ bottom: 500, left: 100, right: 900, top: 100 }),
      requestFrame: frames.request,
    });

    scroller.update({ x: 500, y: 490 });
    expect(onBottomEdge).toHaveBeenCalledWith(true);
    frames.flush();
    const firstDelta = onScroll.mock.calls[0]?.[0] as { readonly x: number; readonly y: number };
    expect(firstDelta.x).toBe(0);
    expect(firstDelta.y).toBeGreaterThan(0);
    expect(frames.callbacks.size).toBe(1);

    scroller.update({ x: 500, y: 300 });
    frames.flush();
    expect(onBottomEdge).toHaveBeenLastCalledWith(false);
    expect(frames.callbacks.size).toBe(0);
  });

  it("bounds frame speed and cancels scheduled work when the drag ends", () => {
    const frames = new Frames();
    const onScroll = vi.fn();
    const scroller = new SelectionEdgeAutoScroller({
      cancelFrame: frames.cancel,
      onBottomEdge: vi.fn(),
      onScroll,
      readViewport: () => ({ bottom: 500, left: 100, right: 900, top: 100 }),
      requestFrame: frames.request,
    });

    scroller.update({ x: 2_000, y: 2_000 });
    frames.flush();
    expect(onScroll).toHaveBeenCalledWith({ x: 16, y: 16 });
    scroller.finish();
    expect(frames.callbacks.size).toBe(0);
  });
});

describe("active editor selection edge integration", () => {
  it("keeps page-layout lifecycle and native navigation in one drag session", () => {
    const frames = new Frames();
    const lifecycle = {
      begin: vi.fn(),
      finish: vi.fn(),
      setBottomEdge: vi.fn(),
      update: vi.fn(),
    };
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
      lifecycle,
      navigation,
      ownerWindow: {
        cancelAnimationFrame: frames.cancel,
        innerHeight: 600,
        innerWidth: 1_000,
        requestAnimationFrame: frames.request,
      } as unknown as Window,
      scrollOwner: () => owner,
    });

    drag.begin();
    drag.update({ x: 910, y: 510 });
    expect(lifecycle.begin).toHaveBeenCalledOnce();
    expect(lifecycle.update).toHaveBeenCalledWith({ x: 910, y: 510 });
    frames.flush();
    expect(lifecycle.setBottomEdge).toHaveBeenCalledWith(true);
    expect(pan.mock.calls[0]?.[0]).toBeLessThan(0);
    expect(scroll.mock.calls[0]?.[0]).toBeLessThan(0);
    drag.finish("commit");
    expect(lifecycle.setBottomEdge).toHaveBeenLastCalledWith(false);
    expect(lifecycle.finish).toHaveBeenCalledWith("commit");
    expect(frames.callbacks.size).toBe(0);
  });
});
