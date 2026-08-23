import { describe, expect, it, vi } from "vitest";

import { derivePageExtent, PAGE_WIDTH } from "../../../../src/domain/geometry/public";
import type { PageV1 } from "../../../../src/domain/schema/public";
import {
  ActiveEditorLayout,
  type ActiveEditorResizeUpdate,
} from "../../../../src/obsidian/embeds/active-editor/layout";
import type { SvgSceneRenderer } from "../../../../src/rendering/scene/index";
import { domRect } from "../../../fixtures/obsidian/active-editor";

class ScheduledWork {
  readonly frames = new Map<number, FrameRequestCallback>();
  readonly timers = new Map<number, () => void>();
  readonly motionQuery = new MotionQuery();
  #next = 1;

  readonly window = {
    cancelAnimationFrame: (id: number): void => void this.frames.delete(id),
    clearTimeout: (id: number): void => void this.timers.delete(id),
    matchMedia: () => this.motionQuery,
    requestAnimationFrame: (callback: FrameRequestCallback): number => {
      const id = this.#next++;
      this.frames.set(id, callback);
      return id;
    },
    setTimeout: (callback: () => void): number => {
      const id = this.#next++;
      this.timers.set(id, callback);
      return id;
    },
  };

  flushFrame(): void {
    const entry = this.frames.entries().next().value;
    if (entry === undefined) throw new Error("No animation frame is pending.");
    this.frames.delete(entry[0]);
    entry[1](0);
  }

  flushFrames(): void {
    while (this.frames.size > 0) this.flushFrame();
  }

  flushTimer(): void {
    const entry = this.timers.entries().next().value;
    if (entry === undefined) throw new Error("No timer is pending.");
    this.timers.delete(entry[0]);
    entry[1]();
  }
}

class MotionQuery {
  matches = false;
  readonly #listeners = new Set<(event: MediaQueryListEvent) => void>();

  addEventListener(_type: "change", listener: (event: MediaQueryListEvent) => void): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: "change", listener: (event: MediaQueryListEvent) => void): void {
    this.#listeners.delete(listener);
  }

  setMatches(matches: boolean): void {
    this.matches = matches;
    for (const listener of this.#listeners) listener({ matches } as MediaQueryListEvent);
  }
}

function page(): PageV1 {
  return {
    activeBufferLines: 3,
    background: { type: "lines", spacing: 100 },
    innerWidth: 2000,
    lockedBufferLines: 1,
    margin: 24.3,
    writingLineHeight: 100,
  };
}

function harness(motion: "full" | "reduced" | "system" = "full", horizontalInset = 0) {
  const work = new ScheduledWork();
  let chromeMutation: MutationCallback | undefined;
  const rect = { height: 0, width: 1_000 };
  const styleProperties = new Map<string, string>();
  const style = {
    get blockSize() {
      return `${String(rect.height)}px`;
    },
    set blockSize(value: string) {
      rect.height = Number.parseFloat(value);
    },
    removeProperty: (name: string) => void styleProperties.delete(name),
    setProperty: (name: string, value: string) => void styleProperties.set(name, value),
  } as unknown as CSSStyleDeclaration;
  const ownerDocument = { defaultView: work.window };
  Object.assign(work.window, {
    getComputedStyle: () => ({
      borderBottomWidth: "0px",
      borderLeftWidth: horizontalInset > 0 ? "2px" : "0px",
      borderRightWidth: horizontalInset > 0 ? "2px" : "0px",
      borderTopWidth: "0px",
      paddingBottom: "0px",
      paddingLeft: horizontalInset > 0 ? `${String(horizontalInset / 2 - 2)}px` : "0px",
      paddingRight: horizontalInset > 0 ? `${String(horizontalInset / 2 - 2)}px` : "0px",
      paddingTop: "0px",
    }),
    MutationObserver: class {
      public constructor(callback: MutationCallback) {
        chromeMutation = callback;
      }

      public disconnect(): void {}

      public observe(): void {}
    },
  });
  const container = {
    getBoundingClientRect: () =>
      domRect({ height: rect.height, left: 0, top: 0, width: rect.width }),
    ownerDocument,
    style,
  } as unknown as HTMLElement;
  const invalidateLayout = vi.fn();
  const renderer = {
    invalidateLayout,
    setCamera: vi.fn(),
    setPage: vi.fn(),
  } as unknown as SvgSceneRenderer;
  const onLayout = vi.fn();
  const onResize = vi.fn<(update: ActiveEditorResizeUpdate) => void>();
  const onZoom = vi.fn();
  let maximumBottom: number | undefined;
  let pageAvailable = true;
  const readPage = vi.fn(() => {
    if (!pageAvailable) throw new Error("The document page is unavailable.");
    return page();
  });
  const layout = new ActiveEditorLayout({
    chromeHost: { querySelector: () => null } as unknown as HTMLElement,
    container,
    onLayout,
    onReady: vi.fn(),
    onResize,
    onZoom,
    page: readPage,
    readResizeAnchor: () => ({
      anchorViewportY: 250,
      embedTopInScrollContent: 200,
      oldCameraX: -400,
      oldRenderedContainerHeight: rect.height,
      oldScrollTop: 500,
      scrollBounds: { min: 0, max: 5_000 },
      viewportWidth: rect.width - horizontalInset,
    }),
    renderer,
    root: { dataset: { inkbookMotion: motion }, ownerDocument } as unknown as HTMLElement,
    storeMaximumBottom: () => maximumBottom,
  });
  return {
    layout,
    invalidateLayout,
    onLayout,
    onResize,
    onZoom,
    rect,
    renderer,
    setMaximumBottom: (value: number | undefined) => {
      maximumBottom = value;
    },
    setPageAvailable: (available: boolean) => {
      pageAvailable = available;
    },
    styleProperties,
    triggerChromeMutation: () => chromeMutation?.([], {} as MutationObserver),
    work,
  };
}

describe("active editor layout integration", () => {
  it("derives width fit from the content box when border and padding are present", () => {
    const test = harness("full", 24);
    test.rect.width = 1_024;
    test.layout.chromeMounted();
    test.work.flushFrames();

    expect(test.onZoom).toHaveBeenCalledWith(1_000 / PAGE_WIDTH);
    test.layout.dispose();
  });

  it("accepts a positive width only after two equal frames and remeasures chrome changes", () => {
    const test = harness();
    test.layout.chromeMounted();
    test.work.flushFrame();
    test.rect.width = 1_100;
    test.work.flushFrame();
    expect(test.onZoom).not.toHaveBeenCalled();
    test.work.flushFrame();
    expect(test.onZoom).toHaveBeenCalledWith(1_100 / PAGE_WIDTH);
    test.work.flushFrames();

    const previousMeasurements = test.onLayout.mock.calls.length;
    test.layout.chromeChanged();
    test.work.flushFrame();
    expect(test.onLayout.mock.calls.length).toBe(previousMeasurements + 1);
    test.layout.dispose();
  });

  it("remeasures after a conditional control leaves the toolbar at the end of its presence motion", () => {
    const test = harness();
    test.layout.chromeMounted();
    test.work.flushFrames();
    const previousMeasurements = test.onLayout.mock.calls.length;

    test.triggerChromeMutation();

    expect(test.work.frames.size).toBe(1);
    test.work.flushFrame();
    expect(test.onLayout.mock.calls.length).toBe(previousMeasurements + 1);
    test.layout.dispose();
  });

  it("cancels and suppresses measurements while the locking model is released", () => {
    const test = harness();
    test.layout.chromeMounted();
    test.work.flushFrames();
    test.layout.chromeChanged();
    expect(test.work.frames.size).toBe(1);

    test.layout.suspend();
    test.setPageAvailable(false);
    expect(test.work.frames.size).toBe(0);
    test.layout.chromeChanged();
    expect(test.work.frames.size).toBe(0);

    test.layout.dispose();
  });
});

describe("active editor layout sizing", () => {
  it("uses the resize hooks to retain horizontal camera and native-scroll anchoring", () => {
    const test = harness();
    test.layout.chromeMounted();
    test.work.flushFrames();
    const initialFit = 1_000 / PAGE_WIDTH;
    const height = derivePageExtent(page(), null).activeHeight;
    test.layout.applyZoom({ blockSize: height * initialFit * 2, zoom: initialFit * 2 });

    test.rect.width = 1_200;
    test.layout.contentChanged();
    test.work.flushFrames();

    expect(test.onResize).toHaveBeenCalledOnce();
    expect(test.onResize.mock.calls[0]?.[0]).toMatchObject({ fitZoom: 1_200 / PAGE_WIDTH });
    expect(test.onResize.mock.calls[0]?.[0].cameraX).not.toBe(0);
    expect(test.onResize.mock.calls[0]?.[0].scrollTop).not.toBe(500);
    expect(test.onZoom).toHaveBeenCalledOnce();
    test.layout.dispose();
  });

  it("starts transient extension at exactly 24 CSS pixels and restores cancellation", () => {
    const test = harness();
    test.layout.chromeMounted();
    test.work.flushFrames();
    const originalHeight = test.rect.height;
    test.layout.beginSelectionEdgeDrag();

    test.layout.updateSelectionEdgeDrag({ x: 500, y: originalHeight - 24.01 });
    expect(test.work.timers.size).toBe(0);
    test.layout.updateSelectionEdgeDrag({ x: 500, y: originalHeight - 24 });
    expect(test.work.timers.size).toBe(1);
    expect(test.rect.height).toBeGreaterThan(originalHeight);
    expect(test.styleProperties.get("transition")).toContain("180ms");

    test.layout.finishSelectionEdgeDrag("cancel");
    test.work.flushTimer();
    expect(test.work.timers.size).toBe(1);
    test.work.flushTimer();
    expect(test.rect.height).toBeCloseTo(originalHeight);
    test.layout.dispose();
  });

  it("applies only one transient buffer per reduced-motion edge update", () => {
    const test = harness("reduced");
    test.layout.chromeMounted();
    test.work.flushFrames();
    const originalHeight = test.rect.height;
    const bufferHeight = 100 * (1_000 / PAGE_WIDTH);
    test.layout.beginSelectionEdgeDrag();

    test.layout.updateSelectionEdgeDrag({ x: 500, y: originalHeight - 10 });
    expect(test.rect.height).toBeCloseTo(originalHeight + bufferHeight);
    expect(test.work.timers.size).toBe(0);
    test.layout.dispose();
  });
});

describe("active editor layout motion", () => {
  it("resolves system reduced motion live and completes an active height transition", () => {
    const test = runningHeightTransition("system");

    test.work.motionQuery.setMatches(true);

    expect(test.work.timers.size).toBe(0);
    expect(test.styleProperties.has("transition")).toBe(false);
    test.layout.dispose();
  });

  it("completes an active transition when the live device preference becomes reduced", () => {
    const test = runningHeightTransition("full");

    test.layout.updateMotion("reduced");

    expect(test.work.timers.size).toBe(0);
    expect(test.styleProperties.has("transition")).toBe(false);
    test.layout.dispose();
  });

  it("commits height, camera, overlay, and native-scroll anchoring in one synchronous update", () => {
    const test = harness("reduced");
    test.layout.chromeMounted();
    test.work.flushFrames();
    test.onResize.mockClear();
    test.layout.beginSelectionEdgeDrag();

    test.layout.setSelectionBottomEdge(true);

    expect(test.onResize).toHaveBeenCalledOnce();
    expect(test.onResize).toHaveBeenCalledWith({
      cameraX: -400,
      fitZoom: 1_000 / PAGE_WIDTH,
      scrollTop: 500,
      zoom: 1_000 / PAGE_WIDTH,
    });
    expect(test.invalidateLayout.mock.calls.length).toBeGreaterThan(0);
    test.layout.dispose();
  });

  it("finishes automatic height motion before a new input gesture proceeds", () => {
    const test = runningHeightTransition("full");

    test.layout.interruptForInput();

    expect(test.work.timers.size).toBe(0);
    expect(test.styleProperties.has("transition")).toBe(false);
    test.layout.dispose();
  });
});

function runningHeightTransition(motion: "full" | "system") {
  const test = harness(motion);
  test.layout.chromeMounted();
  test.work.flushFrames();
  test.layout.beginSelectionEdgeDrag();
  test.layout.setSelectionBottomEdge(true);
  expect(test.work.timers.size).toBe(1);
  return test;
}
