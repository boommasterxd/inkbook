import { describe, expect, it, vi } from "vitest";

import { OUTER_PAGE_WIDTH } from "../../../../src/editor/zoom/zoom";
import { ActiveEditorNavigation } from "../../../../src/obsidian/embeds/active-editor/navigation";
import { ActiveEditorLayout } from "../../../../src/obsidian/embeds/active-editor/layout";
import { derivePageExtent } from "../../../../src/domain/geometry/public";
import type { PageV1 } from "../../../../src/domain/schema/public";
import type { SvgSceneRenderer } from "../../../../src/rendering/scene/index";
import { domRect } from "../../../fixtures/obsidian/active-editor";
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";
import {
  createNavigationHarness as createHarness,
  FrameHarness,
  type MutableRect,
  type NavigationHarness,
} from "../../../fixtures/obsidian/navigation";

describe("active editor navigation", () => {
  it("excludes container borders from the page height used by resize anchors", () => {
    const harness = createHarness({ blockInsets: 2 });
    expect(harness.navigation.readResizeAnchor()?.oldRenderedContainerHeight).toBe(998);
    harness.navigation.dispose();
  });

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
    expect(harness.layoutUpdates).toMatchObject([{ blockSize: 2_000 * newZoom, zoom: newZoom }]);
    expect(harness.sequence).toEqual(["layout", "scroll", "camera"]);
    expect(harness.state().fitZoom).toBeCloseTo(1_000 / OUTER_PAGE_WIDTH);
  });

  it("keeps the gesture's content point anchored while publishing the complete scale", () => {
    const harness = createHarness();
    const oldZoom = harness.navigation.zoom;
    const anchor = { x: 600, y: 400 };

    harness.navigation.beginPinchScreen(anchor);
    harness.navigation.updatePinchScreen(anchor, 4);
    harness.frames.flushOne();

    expect(harness.navigation.zoom).toBeCloseTo(oldZoom * 4);
    expect(600 / harness.navigation.zoom - harness.navigation.cameraX).toBeCloseTo(
      anchor.x / oldZoom,
    );
    expect(harness.frames.pending).toBe(0);
  });

  it("clamps sustained zoom to exactly max(5, fitZoom multiplied by five)", () => {
    const harness = createHarness({
      containerRect: { height: 1_000, left: 0, top: 0, width: 3_000 },
      ownerScrollHeight: 20_000,
    });
    const fitZoom = 3_000 / OUTER_PAGE_WIDTH;

    harness.navigation.beginPinchScreen({ x: 1_000, y: 100 });
    harness.navigation.updatePinchScreen({ x: 1_000, y: 100 }, 100);
    harness.frames.flushAll();

    expect(harness.navigation.zoom).toBeCloseTo(fitZoom * 5);
  });
});

describe("active editor navigation bordered scrolling", () => {
  it("preserves the complete native scroll range with a bordered container", () => {
    const harness = createHarness({ blockInsets: 2, ownerScrollTop: 0 });
    harness.navigation.scroll(-10_000);
    harness.frames.flushOne();
    const pageHeight = 2_000 * harness.navigation.zoom;
    expect(harness.owner.scrollTop).toBeCloseTo(4_000 - 500 + pageHeight - 998);
    harness.navigation.dispose();
  });
});

describe("active editor navigation geometry and lifecycle", () => {
  it("uses a live selection reservation when it projects native scroll bounds", () => {
    let activePageHeight = 2_000;
    const harness = createHarness({
      activePageHeight: () => activePageHeight,
      ownerScrollHeight: 1_500,
      ownerScrollTop: 0,
    });
    activePageHeight = 8_000;

    harness.navigation.scroll(-10_000);
    harness.frames.flushOne();

    expect(harness.owner.scrollTop).toBeGreaterThan(3_000);
  });

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
    harness.navigation.beginPinchScreen({ x: 500, y: 200 });
    harness.navigation.updatePinchScreen({ x: 500, y: 200 }, 4);
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

describe("active editor touch pan momentum", () => {
  it("continues a released horizontal touch flick in the shared camera frame", () => {
    const harness = createZoomedHarness();
    const before = harness.navigation.cameraX;

    releaseFlick(harness);

    expect(harness.navigation.cameraX).toBeLessThan(before);
    expect(harness.frames.pending).toBe(1);
  });

  it("stops when the horizontal camera reaches its bound", () => {
    const harness = createZoomedHarness();
    harness.navigation.finish();
    harness.navigation.pan(-10_000);
    harness.frames.flushOne();
    harness.navigation.finish();
    const atBound = harness.navigation.cameraX;

    releaseFlick(harness);

    expect(harness.navigation.cameraX).toBe(atBound);
    expect(harness.frames.pending).toBe(0);
  });
});

function recordFlick(navigation: ActiveEditorNavigation, now: number): void {
  navigation.recordTouchPan(-12, now - 32);
  navigation.recordTouchPan(-12, now - 16);
  navigation.recordTouchPan(-12, now);
}

function releaseFlick(harness: NavigationHarness): void {
  const now = harness.frames.now;
  recordFlick(harness.navigation, now);
  harness.navigation.releaseTouchPan(now);
  harness.frames.flushOne();
}

function createZoomedHarness(): NavigationHarness {
  const harness = createHarness();
  harness.navigation.beginPinchScreen({ x: 500, y: 200 });
  harness.navigation.updatePinchScreen({ x: 500, y: 200 }, 2);
  harness.frames.flushAll();
  return harness;
}

describe("active editor measured layout", () => {
  it("preserves magnification and remeasures after zoom interrupts height motion", () => {
    const frames = new FrameHarness();
    const rect: MutableRect = { height: 1_000, left: 0, top: 0, width: 1_000 };
    const style = layoutStyle();
    const ownerDocument = { defaultView: frames.window };
    const container = {
      classList: layoutClassList(),
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
      workScheduler: workSchedulerFromFrames(frames.window),
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
    maximumBottom = 2_200;
    layout.contentChanged();
    frames.flushOne();
    expect(frames.pending).toBe(1);

    layout.applyZoom({ blockSize: firstHeight * fitZoom * 2, zoom: fitZoom * 2 });
    expect(frames.pending).toBe(1);
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
      classList: layoutClassList(),
      getBoundingClientRect: () => domRect({ height: 1_000, left: 0, top: 0, width: 1_000 }),
      ownerDocument,
      style: layoutStyle(),
    } as unknown as HTMLElement;
    const onReady = vi.fn();
    const layout = new ActiveEditorLayout({
      workScheduler: workSchedulerFromFrames(frames.window),
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

function layoutClassList(): DOMTokenList {
  return {
    add: vi.fn(),
    remove: vi.fn(),
  } as unknown as DOMTokenList;
}

function layoutStyle(): CSSStyleDeclaration {
  return {
    blockSize: "",
    removeProperty: vi.fn(),
    setProperty: vi.fn(),
  } as unknown as CSSStyleDeclaration;
}

function layoutPage(): PageV1 {
  return {
    activeBufferLines: 3,
    background: { type: "none" },
    innerWidth: 2000,
    lockedBufferLines: 1,
    margin: 24.3,
  };
}
