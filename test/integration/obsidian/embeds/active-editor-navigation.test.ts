import { describe, expect, it, vi } from "vitest";

import { createInputState, type InputState } from "../../../../src/editor/input/index";
import { OUTER_PAGE_WIDTH } from "../../../../src/editor/zoom/index";
import { ActiveEditorNavigation } from "../../../../src/obsidian/embeds/active-editor/navigation";
import { ActiveEditorLayout } from "../../../../src/obsidian/embeds/active-editor/layout";
import { derivePageExtent } from "../../../../src/domain/geometry/public";
import type { PageV1 } from "../../../../src/domain/schema/public";
import type { BrowserScrollElement } from "../../../../src/obsidian/scrolling/index";
import type { SvgSceneRenderer } from "../../../../src/rendering/scene/index";
import { domRect } from "../../../fixtures/obsidian/active-editor";

interface MutableRect {
  height: number;
  left: number;
  top: number;
  width: number;
}

interface NavigationHarness {
  readonly containerRect: MutableRect;
  readonly frames: FrameHarness;
  readonly layoutUpdates: Array<{ readonly blockSize: number; readonly zoom: number }>;
  readonly navigation: ActiveEditorNavigation;
  readonly owner: BrowserScrollElement;
  readonly sequence: string[];
  readonly setCamera: ReturnType<typeof vi.fn>;
  readonly state: () => InputState;
}

class FrameHarness {
  readonly #callbacks = new Map<number, FrameRequestCallback>();
  #nextFrame = 1;

  public readonly window = {
    cancelAnimationFrame: (frame: number): void => {
      this.#callbacks.delete(frame);
    },
    innerHeight: 800,
    innerWidth: 1200,
    requestAnimationFrame: (callback: FrameRequestCallback): number => {
      const frame = this.#nextFrame++;
      this.#callbacks.set(frame, callback);
      return frame;
    },
  };

  public get pending(): number {
    return this.#callbacks.size;
  }

  public flushOne(): void {
    const entry = this.#callbacks.entries().next().value as
      readonly [number, FrameRequestCallback] | undefined;
    if (entry === undefined) throw new Error("No animation frame is pending.");
    this.#callbacks.delete(entry[0]);
    entry[1](0);
  }

  public flushAll(): void {
    while (this.#callbacks.size > 0) this.flushOne();
  }
}

function createHarness(options?: {
  readonly activePageHeight?: number;
  readonly containerRect?: MutableRect;
  readonly ownerRect?: MutableRect;
  readonly ownerScrollHeight?: number;
  readonly ownerScrollTop?: number;
}): NavigationHarness {
  const frames = new FrameHarness();
  const sequence: string[] = [];
  const containerRect = options?.containerRect ?? {
    height: 1_000,
    left: 0,
    top: 100,
    width: 1_000,
  };
  const ownerRect = options?.ownerRect ?? { height: 500, left: 0, top: 0, width: 1_000 };
  let scrollTop = options?.ownerScrollTop ?? 200;
  const documentPort: { defaultView: unknown; scrollingElement: unknown } = {
    defaultView: frames.window,
    scrollingElement: null,
  };
  const owner = {
    clientHeight: ownerRect.height,
    getBoundingClientRect: () => domRect(ownerRect),
    ownerDocument: documentPort,
    scrollHeight: options?.ownerScrollHeight ?? 4_000,
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value: number) {
      sequence.push("scroll");
      scrollTop = value;
    },
  } as unknown as BrowserScrollElement;
  const container = {
    getBoundingClientRect: () => domRect(containerRect),
    ownerDocument: documentPort,
  } as unknown as HTMLElement;
  const fitZoom = containerRect.width / OUTER_PAGE_WIDTH;
  let input = createInputState({ fitZoom, zoom: fitZoom });
  const setCamera = vi.fn(() => sequence.push("camera"));
  const layoutUpdates: Array<{ readonly blockSize: number; readonly zoom: number }> = [];
  const navigation = new ActiveEditorNavigation({
    activePageHeight: () => options?.activePageHeight ?? 2_000,
    applyZoomLayout: (update) => {
      sequence.push("layout");
      layoutUpdates.push(update);
      containerRect.height = update.blockSize;
    },
    container,
    getInput: () => input,
    renderer: { setCamera } as unknown as SvgSceneRenderer,
    scrollOwner: owner,
    setInput: (next) => {
      input = next;
    },
  });
  return {
    containerRect,
    frames,
    layoutUpdates,
    navigation,
    owner,
    sequence,
    setCamera,
    state: () => input,
  };
}

describe("active editor navigation", () => {
  it("coalesces normalized wheel zoom into an anchored owner-window frame", () => {
    const harness = createHarness();
    const oldZoom = harness.navigation.zoom;
    const oldScrollTop = harness.owner.scrollTop;
    const oldPageX = 250 / oldZoom;
    const embedTopInScrollContent = oldScrollTop + 100;
    const oldPageY = (oldScrollTop + 300 - embedTopInScrollContent) / oldZoom;

    harness.navigation.updateWheel({ clientX: 250, clientY: 300, deltaMode: 1, deltaY: -6.25 });

    expect(harness.frames.pending).toBe(1);
    expect(harness.setCamera).not.toHaveBeenCalled();
    harness.frames.flushOne();

    const newZoom = oldZoom * 1.08;
    expect(harness.navigation.zoom).toBeCloseTo(newZoom);
    expect(250 / newZoom - harness.navigation.cameraX).toBeCloseTo(oldPageX);
    expect((harness.owner.scrollTop + 300 - embedTopInScrollContent) / newZoom).toBeCloseTo(
      oldPageY,
    );
    expect(harness.layoutUpdates).toEqual([{ blockSize: 2_000 * newZoom, zoom: newZoom }]);
    expect(harness.sequence).toEqual(["layout", "camera", "scroll"]);
    expect(harness.state().fitZoom).toBeCloseTo(1_000 / OUTER_PAGE_WIDTH);
  });

  it("uses the gesture anchor and caps each coalesced pinch frame at 1.35", () => {
    const harness = createHarness();
    const oldZoom = harness.navigation.zoom;
    const anchor = { x: 600, y: 400 };

    harness.navigation.updatePinch(anchor, 4);
    harness.frames.flushOne();

    expect(harness.navigation.zoom).toBeCloseTo(oldZoom * 1.35);
    expect((600 * oldZoom) / harness.navigation.zoom - harness.navigation.cameraX).toBeCloseTo(
      anchor.x,
    );
    expect(harness.frames.pending).toBe(1);
  });

  it("clamps sustained zoom to exactly max(5, fitZoom multiplied by five)", () => {
    const harness = createHarness({
      containerRect: { height: 1_000, left: 0, top: 0, width: 3_000 },
      ownerScrollHeight: 20_000,
    });
    const fitZoom = 3_000 / OUTER_PAGE_WIDTH;

    harness.navigation.updatePinch({ x: 1_000, y: 100 }, 100);
    harness.frames.flushAll();

    expect(harness.navigation.zoom).toBeCloseTo(fitZoom * 5);
  });
});

describe("active editor navigation geometry and lifecycle", () => {
  it("uses the visible embed and scroll-owner intersection for its center", () => {
    const harness = createHarness({
      containerRect: { height: 2_000, left: 100, top: -200, width: 1_000 },
      ownerRect: { height: 500, left: 50, top: 100, width: 800 },
    });
    const zoom = harness.navigation.zoom;

    expect(harness.navigation.visibleCenter()).toEqual({
      x: 375 / zoom,
      y: 550 / zoom,
    });
  });

  it("coalesces native scrolling and covered horizontal panning and can revert them", () => {
    const harness = createHarness({ ownerScrollHeight: 4_000, ownerScrollTop: 200 });
    harness.navigation.updatePinch({ x: 500, y: 200 }, 4);
    harness.frames.flushAll();
    harness.navigation.finish();
    const originScrollTop = harness.owner.scrollTop;
    const originCameraX = harness.navigation.cameraX;

    harness.navigation.pan(-10_000);
    harness.navigation.scroll(-10_000);
    expect(harness.frames.pending).toBe(1);
    harness.frames.flushOne();

    expect(harness.navigation.cameraX).toBeCloseTo(
      1_000 / harness.navigation.zoom - OUTER_PAGE_WIDTH,
    );
    expect(harness.owner.scrollTop).toBe(3_500);
    harness.navigation.revert();
    expect(harness.navigation.cameraX).toBe(originCameraX);
    expect(harness.owner.scrollTop).toBe(originScrollTop);
  });

  it("maps owner-document pointer coordinates through the current camera", () => {
    const harness = createHarness({
      containerRect: { height: 1_000, left: 50, top: 100, width: 1_000 },
    });
    const point = harness.navigation.pagePoint({ clientX: 250, clientY: 300 });

    expect(harness.navigation.screenPoint(point)).toEqual({ x: 250, y: 300 });
    expect(
      harness.navigation.pointer({
        clientX: 250,
        clientY: 300,
        pointerId: 7,
        pointerType: "pen",
        pressure: 0.4,
      } as PointerEvent),
    ).toEqual({ ...point, pointerId: 7, pointerType: "pen", pressure: 0.4 });
  });

  it("accepts a positive measured fit zoom and rejects invalid measurements", () => {
    const harness = createHarness();

    harness.navigation.setZoom(0.75);
    harness.navigation.setZoom(Number.NaN);

    expect(harness.navigation.zoom).toBe(0.75);
    expect(harness.navigation.cameraX).toBe(0);
    expect(harness.state().fitZoom).toBe(0.75);
    expect(harness.state().zoom).toBe(0.75);
    expect(harness.setCamera).toHaveBeenLastCalledWith({ x: 0, zoom: 0.75 });
  });

  it("cancels a pending navigation frame on disposal", () => {
    const harness = createHarness();
    harness.navigation.updateWheel({ clientX: 10, clientY: 10, deltaMode: 0, deltaY: -100 });

    harness.navigation.dispose();

    expect(harness.frames.pending).toBe(0);
    expect(harness.setCamera).not.toHaveBeenCalled();
  });
});

describe("active editor measured layout", () => {
  it("preserves user magnification across content height and container width changes", () => {
    const frames = new FrameHarness();
    const rect: MutableRect = { height: 1_000, left: 0, top: 0, width: 1_000 };
    const style = { blockSize: "" };
    const ownerDocument = { defaultView: frames.window };
    const container = {
      getBoundingClientRect: () => domRect(rect),
      ownerDocument,
      style,
    } as unknown as HTMLElement;
    const chromeHost = { querySelector: () => null } as unknown as HTMLElement;
    const root = { ownerDocument } as unknown as HTMLElement;
    let maximumBottom = 1_700;
    const onZoom = vi.fn();
    const renderer = {
      invalidateLayout: vi.fn(),
      setCamera: vi.fn(),
      setPage: vi.fn(),
    } as unknown as SvgSceneRenderer;
    const layout = new ActiveEditorLayout({
      chromeHost,
      container,
      onLayout: vi.fn(),
      onReady: vi.fn(),
      onZoom,
      page: () => layoutPage(),
      renderer,
      root,
      storeMaximumBottom: () => maximumBottom,
    });
    layout.contentChanged();
    expect(frames.pending).toBe(0);
    layout.chromeMounted();
    expect(frames.pending).toBe(1);
    frames.flushAll();
    const fitZoom = rect.width / OUTER_PAGE_WIDTH;
    const firstHeight = derivePageExtent(layoutPage(), maximumBottom).activeHeight;
    layout.applyZoom({ blockSize: firstHeight * fitZoom * 2, zoom: fitZoom * 2 });

    maximumBottom = 2_200;
    layout.contentChanged();
    frames.flushAll();
    const nextHeight = derivePageExtent(layoutPage(), maximumBottom).activeHeight;
    expect(style.blockSize).toBe(`${String(nextHeight * fitZoom * 2)}px`);
    expect(onZoom).toHaveBeenCalledTimes(1);

    rect.width = 1_200;
    layout.contentChanged();
    frames.flushAll();
    const resizedZoom = (rect.width / OUTER_PAGE_WIDTH) * 2;
    expect(style.blockSize).toBe(`${String(nextHeight * resizedZoom)}px`);
    expect(onZoom).toHaveBeenLastCalledWith(resizedZoom);
    layout.dispose();
  });

  it("cancels the deferred ready frame when disposed after measurement", () => {
    const frames = new FrameHarness();
    const ownerDocument = { defaultView: frames.window };
    const container = {
      getBoundingClientRect: () => domRect({ height: 1_000, left: 0, top: 0, width: 1_000 }),
      ownerDocument,
      style: { blockSize: "" },
    } as unknown as HTMLElement;
    const onReady = vi.fn();
    const layout = new ActiveEditorLayout({
      chromeHost: { querySelector: () => null } as unknown as HTMLElement,
      container,
      onLayout: vi.fn(),
      onReady,
      onZoom: vi.fn(),
      page: () => layoutPage(),
      renderer: {
        invalidateLayout: vi.fn(),
        setCamera: vi.fn(),
        setPage: vi.fn(),
      } as unknown as SvgSceneRenderer,
      root: { ownerDocument } as unknown as HTMLElement,
      storeMaximumBottom: () => undefined,
    });

    layout.chromeMounted();
    frames.flushOne();
    expect(frames.pending).toBe(1);
    layout.dispose();
    expect(frames.pending).toBe(0);
    expect(onReady).not.toHaveBeenCalled();
  });
});

function layoutPage(): PageV1 {
  return {
    activeBufferLines: 3,
    background: { type: "none" },
    innerWidth: 2000,
    lockedBufferLines: 1,
    margin: 24.3,
    writingLineHeight: 100,
  };
}
