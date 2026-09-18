import { describe, expect, it } from "vitest";

import { createInputState } from "../../../src/editor/input/index";
import { OUTER_PAGE_WIDTH } from "../../../src/editor/zoom/zoom";
import { ActiveEditorNavigation } from "../../../src/obsidian/embeds/active-editor/navigation";
import { INTERACTION_REFRESH_PROFILE, runInteractionFrames } from "../interaction-refresh-profile";
import type { InputState } from "../../../src/editor/input/index";
import type { BrowserScrollElement } from "../../../src/obsidian/scrolling/index";
import type { SvgSceneRenderer } from "../../../src/rendering/scene/index";
import { domRect } from "../../fixtures/obsidian/active-editor";

interface NavigationProfileApi {
  readonly ActiveEditorNavigation: typeof import("../../../src/obsidian/embeds/active-editor/navigation").ActiveEditorNavigation;
  readonly createInputState: typeof import("../../../src/editor/input/index").createInputState;
  readonly OUTER_PAGE_WIDTH: number;
}

class FrameQueue {
  constructor(readonly frameDurationMs: number) {}

  readonly #callbacks = new Map<number, FrameRequestCallback>();
  #handle = 0;
  #maxPending = 0;
  #time = 1_000;

  public readonly window = {
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
  let cameraWrites = 0;
  let layoutWrites = 0;
  let scrollWrites = 0;
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
    clientHeight: 500,
    getBoundingClientRect: () => domRect({ height: 500, left: 0, top: 0, width: 1_000 }),
    ownerDocument,
    scrollHeight: 10_000,
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
    activePageHeight: () => 2_000,
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
    get cameraWrites() {
      return cameraWrites;
    },
    frames,
    get layoutWrites() {
      return layoutWrites;
    },
    navigation,
    resetWrites: () => {
      cameraWrites = 0;
      layoutWrites = 0;
      scrollWrites = 0;
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

    harness.navigation.dispose();
  });

  it("keeps coalesced horizontal pan and native vertical scroll with coalesced work", () => {
    const harness = createPanningHarness();
    runInteractionFrames(navigationFrame(1, harness));
    harness.navigation.finish();

    expect(harness.cameraWrites).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(harness.scrollWrites).toBeGreaterThan(0);

    harness.navigation.dispose();
  });

  it("keeps horizontal trackpad handoff and momentum with coalesced work", () => {
    const harness = createPanningHarness();
    let claimedEvents = 0;
    const update = navigationFrame(2, harness);
    runInteractionFrames((frame) => {
      if (update(frame)) claimedEvents += 1;
    });

    expect(claimedEvents).toBe((INTERACTION_REFRESH_PROFILE.sampleCount / 4) * 3);
    expect(harness.cameraWrites).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(harness.frames.maxPending).toBe(1);
    expect(harness.scrollWrites).toBe(0);

    harness.navigation.dispose();
  });

  it("keeps horizontal touch momentum with coalesced work", () => {
    const harness = createPanningHarness();
    runInteractionFrames(navigationFrame(3, harness));

    expect(harness.cameraWrites).toBeGreaterThan(0);

    harness.navigation.dispose();
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
