import { describe, expect, it } from "vitest";

import { createInputState } from "../../../src/editor/input/index";
import { OUTER_PAGE_WIDTH } from "../../../src/editor/zoom/zoom";
import { ActiveEditorNavigation } from "../../../src/obsidian/embeds/active-editor/navigation";
import { INTERACTION_REFRESH_PROFILE, runInteractionFrames } from "../interaction-refresh-profile";
import type { InputState } from "../../../src/editor/input/index";
import type { BrowserScrollElement } from "../../../src/obsidian/scrolling/index";
import type { SvgSceneRenderer } from "../../../src/rendering/scene/index";
import { domRect } from "../../fixtures/obsidian/active-editor";
import { workSchedulerFromFrames } from "../../fixtures/obsidian/work-scheduler";

interface NavigationProfileApi {
  readonly ActiveEditorNavigation: typeof import("../../../src/obsidian/embeds/active-editor/navigation").ActiveEditorNavigation;
  readonly createInputState: typeof import("../../../src/editor/input/index").createInputState;
  readonly OUTER_PAGE_WIDTH: number;
}

class FrameQueue {
  constructor(readonly frameDurationMs: number) {}

  readonly #callbacks = new Map<number, FrameRequestCallback>();
  readonly #timers = new Map<number, { callback: () => void; due: number }>();
  #maxTimers = 0;
  #handle = 0;
  #maxPending = 0;
  #time = 1_000;

  public readonly window = {
    clearTimeout: (handle: number) => this.#timers.delete(handle),
    setTimeout: (callback: () => void, delay: number) => {
      const handle = ++this.#handle;
      this.#timers.set(handle, { callback, due: this.#time + delay });
      this.#maxTimers = Math.max(this.#maxTimers, this.#timers.size);
      return handle;
    },
    cancelAnimationFrame: (handle: number) => this.#callbacks.delete(handle),
    innerHeight: 800,
    innerWidth: 1_200,
    performance: { now: () => this.#time },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      this.#handle += 1;
      this.#callbacks.set(this.#handle, callback);
      this.#maxPending = Math.max(this.#maxPending, this.#callbacks.size);
      return this.#handle;
    },
  };

  public flush(): void {
    const entry = this.#callbacks.entries().next().value as
      readonly [number, FrameRequestCallback] | undefined;
    if (entry === undefined) throw new Error("No navigation frame is pending.");
    this.#callbacks.delete(entry[0]);
    this.#time += this.frameDurationMs;
    entry[1](this.#time);
  }

  public advanceQuiet(ms: number): void {
    this.#time += ms;
    for (const [handle, timer] of this.#timers) {
      if (timer.due > this.#time) continue;
      this.#timers.delete(handle);
      timer.callback();
    }
  }

  public get maxTimers(): number {
    return this.#maxTimers;
  }
  public get pendingTimers(): number {
    return this.#timers.size;
  }

  public get now(): number {
    return this.#time;
  }

  public get maxPending(): number {
    return this.#maxPending;
  }

  public get pending(): number {
    return this.#callbacks.size;
  }
}

function startNavigationFlick(
  harness: ReturnType<typeof buildNavigationHarness>,
  direction: number,
): void {
  const now = harness.frames.now;
  const step = harness.frames.frameDurationMs;
  harness.navigation.recordTouchPan(direction * 8, now - step * 2);
  harness.navigation.recordTouchPan(direction * 8, now - step);
  harness.navigation.recordTouchPan(direction * 8, now);
  harness.navigation.releaseTouchPan(now);
}

function buildNavigationHarness(api: NavigationProfileApi, refreshRate: number) {
  const { ActiveEditorNavigation, createInputState, OUTER_PAGE_WIDTH } = api;
  const frames = new FrameQueue(1000 / refreshRate);
  const rect = { height: 1_000, left: 0, top: 100, width: 1_000 };
  let scrollTop = 200;
  const activity: boolean[] = [];
  let cameraWrites = 0;
  let layoutWrites = 0;
  let scrollWrites = 0;
  let layoutReads = 0;
  let scrollHeightReads = 0;
  let pageReads = 0;
  let input: InputState = createInputState({
    fitZoom: rect.width / OUTER_PAGE_WIDTH,
    zoom: rect.width / OUTER_PAGE_WIDTH,
  });
  const ownerDocument = {
    defaultView: {
      ...frames.window,
      getComputedStyle: () => ({ borderTopWidth: "1px", borderBottomWidth: "1px" }),
    },
    scrollingElement: null,
  };
  const owner = {
    get clientHeight() {
      layoutReads += 1;
      return 500;
    },
    getBoundingClientRect: () => domRect({ height: 500, left: 0, top: 0, width: 1_000 }),
    ownerDocument,
    get scrollHeight() {
      scrollHeightReads += 1;
      return 10_000;
    },
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value: number) {
      scrollTop = value;
      scrollWrites += 1;
    },
  } as unknown as BrowserScrollElement;
  const container = {
    getBoundingClientRect: () => domRect(rect),
    ownerDocument,
  } as unknown as HTMLElement;
  const navigation = new ActiveEditorNavigation({
    workScheduler: workSchedulerFromFrames(frames.window),
    onNavigationActive: (active) => activity.push(active),
    activePageHeight: () => {
      pageReads += 1;
      return 2_000;
    },
    applyZoomLayout: ({ blockSize }) => {
      rect.height = blockSize + 2;
      layoutWrites += 1;
    },
    container,
    getInput: () => input,
    renderer: {
      setCamera: () => {
        cameraWrites += 1;
      },
    } as unknown as SvgSceneRenderer,
    scrollOwner: owner,
    setInput: (next) => {
      input = next;
    },
  });
  return {
    activity,
    get cameraWrites() {
      return cameraWrites;
    },
    frames,
    get layoutReads() {
      return layoutReads;
    },
    get layoutWrites() {
      return layoutWrites;
    },
    get workReads() {
      return { page: pageReads, scrollHeight: scrollHeightReads };
    },
    navigation,
    resetWrites: () => {
      layoutReads = 0;
      cameraWrites = 0;
      layoutWrites = 0;
      scrollWrites = 0;
      scrollHeightReads = 0;
      pageReads = 0;
    },
    get scrollWrites() {
      return scrollWrites;
    },
  };
}

function navigationFrame(mode: number, harness: ReturnType<typeof buildNavigationHarness>) {
  return (frame: number): boolean => {
    let claimed = false;
    if (mode === 0) {
      claimed = harness.navigation.updateWheel({
        clientX: 500,
        clientY: 300,
        ctrlKey: true,
        deltaMode: 0,
        deltaX: 0,
        deltaY: frame % 2 === 0 ? -4 : 4,
        metaKey: false,
      });
    } else if (mode === 1) {
      const delta = frame % 2 === 0 ? 3 : -3;
      harness.navigation.pan(delta);
      harness.navigation.scroll(delta);
    } else if (mode === 2) {
      if (frame % 4 < 3) {
        const direction = Math.floor(frame / 4) % 2 === 0 ? 1 : -1;
        claimed = harness.navigation.updateWheel({
          clientX: 500,
          clientY: 300,
          ctrlKey: false,
          deltaMode: 0,
          deltaX: direction * 6,
          deltaY: 1,
          metaKey: false,
          shiftKey: false,
        });
      }
    } else if (harness.frames.pending === 0) {
      startNavigationFlick(harness, frame % 2 === 0 ? 1 : -1);
    }
    harness.frames.flush();
    return claimed;
  };
}

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz navigation profile`, () => {
  it("defers native wheel work through a renewable quiet tail and releases camera cancellation", () => {
    const harness = createNavigationHarness();
    expect(
      harness.navigation.updateWheel({
        clientX: 500,
        clientY: 300,
        deltaMode: 0,
        deltaX: 0,
        deltaY: 4,
      }),
    ).toBe(false);
    harness.frames.advanceQuiet(100);
    harness.navigation.updateWheel({
      clientX: 500,
      clientY: 300,
      deltaMode: 0,
      deltaX: 0,
      deltaY: 4,
    });
    harness.frames.advanceQuiet(100);
    harness.navigation.notifyScroll();
    harness.frames.advanceQuiet(119);
    expect(harness.activity).toEqual([true]);
    expect(harness.frames.pending).toBe(0);
    harness.frames.advanceQuiet(1);
    expect(harness.activity).toEqual([true, false]);
    harness.navigation.updateKeyboardStep(1, null);
    harness.frames.advanceQuiet(1_000);
    expect(harness.activity).toEqual([true, false, true]);
    harness.navigation.cancelNavigation();
    expect(harness.activity).toEqual([true, false, true, false]);
    expect(harness.frames.pending).toBe(0);
    expect(harness.frames.pendingTimers).toBe(0);
    expect(harness.frames.maxTimers).toBe(1);
    harness.navigation.dispose();
  });

  it("releases priority after the last camera frame and quiet tail", () => {
    const harness = createNavigationHarness();
    harness.navigation.updateKeyboardStep(1, null);
    while (harness.frames.pending > 0) harness.frames.flush();
    harness.frames.advanceQuiet(119);
    expect(harness.activity).toEqual([true]);
    harness.frames.advanceQuiet(1);
    expect(harness.activity).toEqual([true, false]);
    expect(harness.frames.pendingTimers).toBe(0);
    expect(harness.frames.maxTimers).toBe(1);
    harness.navigation.dispose();
  });
});

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz navigation work`, () => {
  it.each([0, 1, 2])("leaves native vertical wheel mode %s free of layout reads", (deltaMode) => {
    const harness = createPanningHarness();
    runInteractionFrames(() => {
      expect(
        harness.navigation.updateWheel({
          clientX: 500,
          clientY: 300,
          deltaMode,
          deltaX: 0,
          deltaY: 4,
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
        }),
      ).toBe(false);
    });
    expect(harness.layoutReads).toBe(0);
    expect(harness.frames.pending).toBe(0);
    disposeActiveNavigation(harness);
  });

  it("keeps continuous anchored trackpad zoom with coalesced work", () => {
    const harness = createNavigationHarness();
    let claimedFrames = 0;
    const update = navigationFrame(0, harness);
    runInteractionFrames((frame) => {
      if (update(frame)) claimedFrames += 1;
    });

    expect(claimedFrames).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(harness.cameraWrites).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(harness.layoutWrites).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    // The viewport's measured client height is reused for the projected native range.
    expect(harness.layoutReads).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(harness.workReads.scrollHeight).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(harness.workReads.page).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);

    disposeActiveNavigation(harness);
  });

  it("keeps coalesced horizontal pan and native vertical scroll with coalesced work", () => {
    const harness = createPanningHarness();
    runInteractionFrames(navigationFrame(1, harness));
    harness.navigation.finish();

    expect(harness.cameraWrites).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(harness.scrollWrites).toBeGreaterThan(0);

    disposeActiveNavigation(harness);
  });

  it.each([
    { input: "trackpad handoff", mode: 2 },
    { input: "touch", mode: 3 },
  ])("keeps horizontal $input momentum with coalesced work", ({ mode }) => {
    const harness = createPanningHarness();
    let claimedEvents = 0;
    const update = navigationFrame(mode, harness);
    runInteractionFrames((frame) => {
      if (update(frame)) claimedEvents += 1;
    });

    if (mode === 2) {
      expect(claimedEvents).toBe((INTERACTION_REFRESH_PROFILE.sampleCount / 4) * 3);
      expect(harness.cameraWrites).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
      expect(harness.frames.maxPending).toBe(1);
    } else expect(harness.cameraWrites).toBeGreaterThan(0);
    expect(harness.scrollWrites).toBe(0);
    expect(harness.workReads.scrollHeight).toBe(0);
    expect(harness.workReads.page).toBe(0);
    expect(harness.layoutWrites).toBe(0);
    expect(harness.layoutReads).toBeLessThanOrEqual(INTERACTION_REFRESH_PROFILE.sampleCount);

    disposeActiveNavigation(harness);
  });
});

function createPanningHarness(): ReturnType<typeof createNavigationHarness> {
  const harness = createNavigationHarness();
  expect(harness.navigation.restoreViewState({ cameraX: -100, zoom: 1 })).toBe(true);
  harness.resetWrites();
  return harness;
}

function createNavigationHarness() {
  return buildNavigationHarness(
    { ActiveEditorNavigation, createInputState, OUTER_PAGE_WIDTH },
    INTERACTION_REFRESH_PROFILE.refreshRate,
  );
}

function disposeActiveNavigation(harness: ReturnType<typeof createNavigationHarness>): void {
  expect(harness.activity).toEqual([true]);
  expect(harness.frames.maxTimers).toBeLessThanOrEqual(1);
  harness.navigation.dispose();
  expect(harness.activity).toEqual([true, false]);
  expect(harness.frames.pendingTimers).toBe(0);
}
