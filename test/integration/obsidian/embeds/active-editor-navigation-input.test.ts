import { describe, expect, it, vi } from "vitest";

import { createInputState, type InputState } from "../../../../src/editor/input/index";
import { OUTER_PAGE_WIDTH } from "../../../../src/editor/zoom/zoom";
import {
  ActiveEditorNavigation,
  type ActiveEditorWheelInput,
} from "../../../../src/obsidian/embeds/active-editor/navigation";
import { responsiveTrackpadPanDelta } from "../../../../src/obsidian/embeds/active-editor/trackpad-pan-momentum";
import type { BrowserScrollElement } from "../../../../src/obsidian/scrolling/index";
import type { SvgSceneRenderer } from "../../../../src/rendering/scene/index";
import { domRect } from "../../../fixtures/obsidian/active-editor";
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";

class Frames {
  readonly callbacks = new Map<number, FrameRequestCallback>();
  #next = 1;
  #now = 0;

  readonly window = {
    cancelAnimationFrame: (frame: number) => this.callbacks.delete(frame),
    innerHeight: 600,
    innerWidth: 1_000,
    performance: { now: () => this.#now },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const frame = this.#next++;
      this.callbacks.set(frame, callback);
      return frame;
    },
  };

  flush(timestamp = 0): void {
    const entry = this.callbacks.entries().next().value as
      readonly [number, FrameRequestCallback] | undefined;
    if (entry === undefined) throw new Error("No frame is pending.");
    this.callbacks.delete(entry[0]);
    this.#now = timestamp;
    entry[1](timestamp);
  }

  setNow(timestamp: number): void {
    this.#now = timestamp;
  }
}

function createHarness(activePageHeight = () => 2000) {
  const frames = new Frames();
  const sequence: string[] = [];
  const rect = { height: 1_000, left: 20, top: 100, width: 1_000 };
  let scrollTop = 200;
  let input: InputState = createInputState({
    fitZoom: rect.width / OUTER_PAGE_WIDTH,
    zoom: rect.width / OUTER_PAGE_WIDTH,
  });
  const documentPort = { defaultView: frames.window, scrollingElement: null };
  const owner = {
    clientHeight: 500,
    getBoundingClientRect: () => domRect({ height: 500, left: 0, top: 0, width: 1_000 }),
    ownerDocument: documentPort,
    scrollHeight: 4_000,
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value: number) {
      sequence.push("scroll-write");
      scrollTop = value;
    },
  } as unknown as BrowserScrollElement;
  const readBounds = vi.fn(() => {
    sequence.push("layout-read");
    return domRect(rect);
  });
  const container = {
    getBoundingClientRect: readBounds,
    ownerDocument: documentPort,
  } as unknown as HTMLElement;
  const navigation = new ActiveEditorNavigation({
    workScheduler: workSchedulerFromFrames(frames.window),
    activePageHeight,
    applyZoomLayout: ({ blockSize }) => {
      sequence.push("layout-write");
      rect.height = blockSize;
    },
    container,
    getInput: () => input,
    renderer: {
      setCamera: () => sequence.push("camera-write"),
    } as unknown as SvgSceneRenderer,
    scrollOwner: owner,
    setInput: (next) => {
      input = next;
    },
  });
  return { frames, input: () => input, navigation, owner, readBounds, rect, sequence };
}

describe("active editor keyboard and wheel navigation", () => {
  it.each(["wheel", "keyboard"])(
    "measures %s anchors after intervening native layout changes",
    (source) => {
      const harness = createHarness();
      const oldZoom = harness.navigation.zoom;
      if (source === "wheel") harness.navigation.updateWheel(zoomWheel(-4));
      else harness.navigation.updateKeyboardStep(1, { x: 400, y: 200 });
      expect(harness.readBounds).not.toHaveBeenCalled();
      harness.owner.scrollTop = 280;
      Object.assign(harness.rect, { left: 50, top: 20 });
      const anchorX = source === "wheel" ? 500 - 50 : 400;
      const anchorViewportY = source === "wheel" ? 300 : 220;
      const oldPageY = (280 + anchorViewportY - 300) / oldZoom;

      harness.frames.flush();

      expect(harness.readBounds).toHaveBeenCalledOnce();
      expect(anchorX / harness.navigation.zoom - harness.navigation.cameraX).toBeCloseTo(
        anchorX / oldZoom,
      );
      expect(
        (harness.owner.scrollTop + anchorViewportY - 300) / harness.navigation.zoom,
      ).toBeCloseTo(oldPageY);
      harness.navigation.dispose();
    },
  );

  it("pans horizontally without deriving page height or reading native scroll range", () => {
    const pageHeight = vi.fn(() => 2000);
    const harness = createHarness(pageHeight);
    harness.navigation.restoreViewState({ cameraX: -100, zoom: 1 });
    pageHeight.mockClear();
    const readScrollHeight = vi.fn(() => 4000);
    Object.defineProperty(harness.owner, "scrollHeight", { get: readScrollHeight });
    const previousScrollTop = harness.owner.scrollTop;
    harness.sequence.length = 0;

    harness.navigation.pan(-30);
    harness.frames.flush();

    expect(harness.navigation.cameraX).toBe(-130);
    expect(harness.owner.scrollTop).toBe(previousScrollTop);
    expect(harness.sequence).toEqual(["layout-read", "layout-read", "camera-write"]);
    expect(pageHeight).not.toHaveBeenCalled();
    expect(readScrollHeight).not.toHaveBeenCalled();
    harness.navigation.dispose();
  });

  it("applies magnitude-proportional trackpad pinch zoom in the next animation frame", () => {
    const harness = createHarness();
    const oldZoom = harness.navigation.zoom;

    expect(harness.navigation.updateWheel(zoomWheel(-4))).toBe(true);
    harness.frames.flush();

    expect(harness.navigation.zoom).toBeCloseTo(oldZoom * Math.exp(0.04));
  });

  it.each([1, 2])("keeps line/page wheel mode %s at one discrete step", (deltaMode) => {
    const harness = createHarness();
    const oldZoom = harness.navigation.zoom;
    expect(harness.navigation.updateWheel({ ...zoomWheel(-100), deltaMode })).toBe(true);
    harness.frames.flush();
    expect(harness.navigation.zoom).toBeCloseTo(oldZoom * 1.08);
    expect(harness.frames.callbacks.size).toBe(0);
  });

  it("applies keyboard zoom through the same atomic anchored frame", () => {
    const harness = createHarness();
    const pointer = { x: 400, y: 200 };
    const oldScrollTop = harness.owner.scrollTop;
    const oldPage = harness.navigation.pagePointFromScreen(pointer);
    const anchorViewportY = 100 + pointer.y;
    const embedTopInScrollContent = oldScrollTop + 100;

    expect(harness.navigation.updateKeyboardStep(1, pointer)).toBe(true);
    harness.frames.flush();

    expect(harness.navigation.zoom).toBeCloseTo((1_000 / OUTER_PAGE_WIDTH) * 1.08);
    expect(harness.navigation.pagePointFromScreen(pointer).x).toBeCloseTo(oldPage.x);
    expect(
      (harness.owner.scrollTop + anchorViewportY - embedTopInScrollContent) /
        harness.navigation.zoom,
    ).toBeCloseTo(oldPage.y);
    expect(harness.sequence.slice(-3)).toEqual(["layout-write", "scroll-write", "camera-write"]);
  });
});

describe("continuous pixel-wheel response", () => {
  it("remains monotonic across the former magnitude boundary and ignores horizontal magnitude", () => {
    let previous = 1;
    for (const magnitude of [0.1, 4, 15.9, 16, 16.1, 20]) {
      const harness = createHarness();
      const before = harness.navigation.zoom;
      harness.navigation.updateWheel({ ...zoomWheel(-magnitude), deltaX: 80 });
      expect(harness.frames.callbacks.size).toBe(1);
      harness.frames.flush();
      const factor = harness.navigation.zoom / before;
      expect(factor).toBeCloseTo(Math.exp(magnitude / 100), 12);
      expect(factor).toBeGreaterThan(previous);
      previous = factor;
      harness.navigation.dispose();
    }
  });

  it.each([false, true])("preserves event partitioning with per-event frames=%s", (flushEach) => {
    for (const deltas of [[-32], [-16, -16], [-8, -8, -8, -8]]) {
      const harness = createHarness();
      const before = harness.navigation.zoom;
      for (const delta of deltas) {
        harness.navigation.updateWheel(zoomWheel(delta));
        expect(harness.frames.callbacks.size).toBe(1);
        if (flushEach) harness.frames.flush();
      }
      for (let frame = 0; harness.frames.callbacks.size > 0; frame += 1) {
        expect(frame).toBeLessThan(8);
        expect(harness.frames.callbacks.size).toBe(1);
        harness.frames.flush();
      }
      expect(harness.navigation.zoom).toBeCloseTo(before * Math.exp(0.32), 12);
      harness.navigation.dispose();
    }
  });
});

describe("continuous zoom limit and reversal handling", () => {
  it("caps huge finite input at the actual camera bounds without stale frame work", () => {
    const harness = createHarness();
    const fit = harness.navigation.zoom;
    for (const [delta, target] of [
      [-Number.MAX_VALUE, 5],
      [Number.MAX_VALUE, fit],
    ]) {
      expect(() => harness.navigation.updateWheel(zoomWheel(delta!))).not.toThrow();
      for (let frame = 0; harness.frames.callbacks.size > 0; frame += 1) {
        expect(frame).toBe(0);
        expect(harness.frames.callbacks.size).toBe(1);
        harness.frames.flush();
      }
      expect(harness.navigation.zoom).toBeCloseTo(target!, 12);
    }
    harness.navigation.dispose();
  });

  it("reverses the next frame instead of draining the previous zoom direction", () => {
    const harness = createHarness();
    harness.navigation.updateWheel(zoomWheel(-Number.MAX_VALUE));
    harness.frames.flush();
    const beforeReversal = harness.navigation.zoom;
    harness.navigation.updateWheel(zoomWheel(4));
    harness.frames.flush();
    expect(harness.navigation.zoom).toBeLessThan(beforeReversal);
    expect(harness.navigation.zoom).toBeCloseTo(beforeReversal * Math.exp(-0.04), 12);
    expect(harness.frames.callbacks.size).toBe(0);
    harness.navigation.dispose();
  });
});

describe("active editor navigation input ordering", () => {
  it("uses the latest anchor when wheel and keyboard zoom race in one frame", () => {
    const keyboardLast = createHarness();
    const keyboardOldScrollTop = keyboardLast.owner.scrollTop;
    keyboardLast.navigation.updateWheel({
      clientX: 200,
      clientY: 250,
      deltaMode: 1,
      deltaY: -6.25,
    });
    const keyboardPointer = { x: 400, y: 200 };
    const keyboardPage = keyboardLast.navigation.pagePointFromScreen(keyboardPointer);
    const keyboardAnchorViewportY = 100 + keyboardPointer.y;
    keyboardLast.navigation.updateKeyboardStep(1, keyboardPointer);
    keyboardLast.frames.flush();

    expect(keyboardLast.navigation.pagePointFromScreen(keyboardPointer).x).toBeCloseTo(
      keyboardPage.x,
    );
    expect(
      (keyboardLast.owner.scrollTop + keyboardAnchorViewportY - (keyboardOldScrollTop + 100)) /
        keyboardLast.navigation.zoom,
    ).toBeCloseTo(keyboardPage.y);

    const wheelLast = createHarness();
    const oldZoom = wheelLast.navigation.zoom;
    const wheelClient = { x: 800, y: 350 };
    const wheelPageX = (wheelClient.x - 20) / oldZoom;
    const wheelPageY = (wheelLast.owner.scrollTop + wheelClient.y - 300) / oldZoom;
    wheelLast.navigation.updateKeyboardStep(1, { x: 200, y: 200 });
    wheelLast.navigation.updateWheel({
      clientX: wheelClient.x,
      clientY: wheelClient.y,
      deltaMode: 1,
      deltaY: -6.25,
    });
    wheelLast.frames.flush();

    expect(
      (wheelClient.x - 20) / wheelLast.navigation.zoom - wheelLast.navigation.cameraX,
    ).toBeCloseTo(wheelPageX);
    expect(
      (wheelLast.owner.scrollTop + wheelClient.y - 300) / wheelLast.navigation.zoom,
    ).toBeCloseTo(wheelPageY);
  });
});

describe("active editor horizontal wheel routing", () => {
  it("claims horizontal trackpad and Shift-wheel input only above fit", () => {
    const harness = createHarness();
    expect(harness.navigation.updateWheel(horizontalWheel())).toBe(false);
    harness.navigation.restoreViewState({ cameraX: -100, zoom: 1 });

    expect(harness.navigation.updateWheel(horizontalWheel({ deltaX: 1, deltaY: 20 }))).toBe(false);
    harness.frames.setNow(0);
    expect(harness.navigation.updateWheel(horizontalWheel({ deltaX: 20, deltaY: 18 }))).toBe(true);
    harness.frames.setNow(16);
    expect(harness.navigation.updateWheel(horizontalWheel())).toBe(true);
    harness.frames.setNow(32);
    expect(
      harness.navigation.updateWheel(
        horizontalWheel({ deltaMode: 1, deltaX: 0, deltaY: 2, shiftKey: true }),
      ),
    ).toBe(true);
    harness.frames.flush();

    expect(harness.navigation.cameraX).toBeCloseTo(
      -100 + responsiveTrackpadPanDelta(-20, undefined) + responsiveTrackpadPanDelta(-80, 16) - 32,
    );
  });

  it("continues a horizontal pixel-wheel burst after its native inertial tail ends", () => {
    const harness = createHarness();
    harness.navigation.restoreViewState({ cameraX: -100, zoom: 1 });
    for (const [timestamp, deltaX, deltaY] of [
      [0, 10, 2],
      [16, 8, 2],
      [32, 5, 3],
      [48, 3, 2],
    ] as const) {
      harness.frames.setNow(timestamp);
      expect(harness.navigation.updateWheel(horizontalWheel({ deltaX, deltaY }))).toBe(true);
      harness.frames.flush(timestamp);
    }

    const directPan = [-10, -8, -5, -3]
      .map((delta, index) => responsiveTrackpadPanDelta(delta, index === 0 ? undefined : 16))
      .reduce((total, delta) => total + delta, 0);
    expect(harness.navigation.cameraX).toBeCloseTo(-100 + directPan);
    expect(harness.frames.callbacks.size).toBe(1);
    harness.frames.flush(64);
    expect(harness.navigation.cameraX).toBeCloseTo(-100 + directPan);
    harness.frames.flush(72);
    expect(harness.navigation.cameraX).toBeCloseTo(-100 + directPan);
    harness.frames.flush(88);

    expect(harness.navigation.cameraX).toBeLessThan(-100 + directPan);
    expect(harness.sequence).not.toContain("scroll-write");
  });
});

describe("active editor pointer-anchored keyboard navigation", () => {
  it("anchors keyboard zoom to the last screen position after pan and resize", () => {
    const harness = createHarness();
    const lastScreenPointer = { x: 400, y: 200 };
    harness.navigation.restoreViewState({ cameraX: -100, zoom: 1 });

    harness.navigation.pan(-120);
    harness.frames.flush();
    harness.navigation.finish();
    const expectKeyboardZoomAnchor = (expectedPageX: number) => {
      harness.navigation.updateKeyboardStep(1, lastScreenPointer);
      harness.frames.flush();
      expect(harness.navigation.pagePointFromScreen(lastScreenPointer).x).toBeCloseTo(
        expectedPageX,
      );
    };
    const pageAfterPan = harness.navigation.pagePointFromScreen(lastScreenPointer);
    expectKeyboardZoomAnchor(pageAfterPan.x);

    harness.rect.width = 1_200;
    expect(
      harness.navigation.applyResize({
        cameraX: -250,
        fitZoom: 1_200 / OUTER_PAGE_WIDTH,
        scrollTop: harness.owner.scrollTop,
        zoom: 1.2,
      }),
    ).toBe(true);
    const pageAfterResize = harness.navigation.pagePointFromScreen(lastScreenPointer);
    expectKeyboardZoomAnchor(pageAfterResize.x);
  });

  it("applies transition camera state without rewriting native scroll", () => {
    const harness = createHarness();
    const scrollTop = harness.owner.scrollTop;
    harness.sequence.length = 0;

    expect(
      harness.navigation.applyResize({
        cameraX: -120,
        fitZoom: 1,
        zoom: 1.2,
      }),
    ).toBe(true);

    expect(harness.owner.scrollTop).toBe(scrollTop);
    expect(harness.sequence).toEqual(["camera-write"]);
  });
});

describe("active editor gesture geometry and view transfer", () => {
  it("keeps arbitration in screen pixels and caches geometry across samples", () => {
    const harness = createHarness();
    harness.navigation.restoreViewState({ cameraX: -100, zoom: 2 });
    harness.readBounds.mockClear();
    expect(harness.navigation.beginGestureGeometry()).toBe(true);
    const event = {
      clientX: 220,
      clientY: 300,
      pointerId: 4,
      pointerType: "touch",
      pressure: 0.5,
    } as PointerEvent;

    const screen = harness.navigation.screenPointer(event);
    expect(screen).toMatchObject({ x: 200, y: 200 });
    expect(harness.navigation.pageSample(screen)).toMatchObject({ x: 200, y: 100 });
    expect(harness.navigation.localPointFromPage({ x: 200, y: 100 })).toEqual({ x: 200, y: 200 });
    expect(harness.navigation.screenPoint({ x: 200, y: 100 })).toEqual({ x: 220, y: 300 });
    harness.navigation.screenPointer({ ...event, clientX: 230 });
    harness.navigation.beginPinchScreen({ x: 200, y: 200 });
    harness.navigation.updatePinchScreen({ x: 210, y: 200 }, 1.1);
    expect(harness.readBounds).toHaveBeenCalledTimes(1);
    harness.frames.flush();
    expect(harness.readBounds).toHaveBeenCalledTimes(2);
    harness.navigation.finish();
  });

  it("preserves a clamped camera across zoom updates, remount restoration, and owner transfer", () => {
    const harness = createHarness();
    expect(harness.navigation.restoreViewState({ cameraX: -300, zoom: 1 })).toBe(true);
    expect(harness.navigation.cameraX).toBe(-300);
    expect(harness.navigation.getViewState()).toEqual({ cameraX: -300, zoom: 1 });

    const secondDocument = { defaultView: harness.frames.window, scrollingElement: null };
    const secondOwner = {
      clientHeight: 400,
      getBoundingClientRect: () => domRect({ height: 400, left: 0, top: 0, width: 900 }),
      ownerDocument: secondDocument,
      scrollHeight: 3_000,
      scrollTop: 50,
    } as unknown as BrowserScrollElement;
    expect(harness.navigation.transferScrollOwner(secondOwner)).toBe(true);
    expect(harness.navigation.transferScrollOwner(secondOwner)).toBe(false);
    expect(harness.navigation.getViewState()).toEqual({ cameraX: -300, zoom: 1 });
  });
});

function horizontalWheel(overrides: Partial<ActiveEditorWheelInput> = {}): ActiveEditorWheelInput {
  return {
    clientX: 100,
    clientY: 100,
    ctrlKey: false,
    deltaMode: 0,
    deltaX: 80,
    deltaY: 10,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

function zoomWheel(deltaY: number): ActiveEditorWheelInput {
  return {
    clientX: 500,
    clientY: 300,
    ctrlKey: true,
    deltaMode: 0,
    deltaX: 0,
    deltaY,
    metaKey: false,
  };
}
