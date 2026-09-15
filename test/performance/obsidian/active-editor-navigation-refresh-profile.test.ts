import { describe, expect, it } from "vitest";

import { createInputState, type InputState } from "../../../src/editor/input/index";
import { OUTER_PAGE_WIDTH } from "../../../src/editor/zoom/zoom";
import { ActiveEditorNavigation } from "../../../src/obsidian/embeds/active-editor/navigation";
import type { BrowserScrollElement } from "../../../src/obsidian/scrolling/index";
import type { SvgSceneRenderer } from "../../../src/rendering/scene/index";
import { domRect } from "../../fixtures/obsidian/active-editor";
import {
  INTERACTION_REFRESH_PROFILE,
  interactionP99,
  interactionProfileAnnotation,
  measureInteractionFrames,
} from "../interaction-refresh-profile";
import { expectTiming } from "../timing-assertions";

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz navigation profile`, () => {
  it("keeps continuous anchored trackpad zoom within budget", async ({ annotate }) => {
    const harness = createNavigationHarness();
    let claimedFrames = 0;
    const durations = measureInteractionFrames((frame) => {
      if (
        harness.navigation.updateWheel({
          clientX: 500,
          clientY: 300,
          ctrlKey: true,
          deltaMode: 0,
          deltaX: 0,
          deltaY: frame % 2 === 0 ? -4 : 4,
          metaKey: false,
        })
      ) {
        claimedFrames += 1;
      }
      harness.frames.flush();
    });

    const p99 = interactionP99(durations);
    expect(claimedFrames).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(harness.cameraWrites).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(harness.layoutWrites).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    await annotate(interactionProfileAnnotation("trackpad zoom", p99), "performance");
    harness.navigation.dispose();
  });

  it("keeps coalesced horizontal pan and native vertical scroll within budget", async ({
    annotate,
  }) => {
    const harness = createPanningHarness();
    const durations = measureInteractionFrames((frame) => {
      const delta = frame % 2 === 0 ? 3 : -3;
      harness.navigation.pan(delta);
      harness.navigation.scroll(delta);
      harness.frames.flush();
    });
    harness.navigation.finish();

    const p99 = interactionP99(durations);
    expect(harness.cameraWrites).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(harness.scrollWrites).toBeGreaterThan(0);
    expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    await annotate(interactionProfileAnnotation("pan and native scroll", p99), "performance");
    harness.navigation.dispose();
  });

  it("keeps horizontal trackpad handoff and momentum within budget", async ({ annotate }) => {
    const harness = createPanningHarness();
    let claimedEvents = 0;
    const durations = measureInteractionFrames((frame) => {
      const phase = frame % 4;
      if (phase < 3) {
        const direction = Math.floor(frame / 4) % 2 === 0 ? 1 : -1;
        if (
          harness.navigation.updateWheel({
            clientX: 500,
            clientY: 300,
            ctrlKey: false,
            deltaMode: 0,
            deltaX: direction * 6,
            deltaY: 1,
            metaKey: false,
            shiftKey: false,
          })
        ) {
          claimedEvents += 1;
        }
      }
      harness.frames.flush();
    });

    const p99 = interactionP99(durations);
    expect(claimedEvents).toBe((INTERACTION_REFRESH_PROFILE.sampleCount / 4) * 3);
    expect(harness.cameraWrites).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(harness.frames.maxPending).toBe(1);
    expect(harness.scrollWrites).toBe(0);
    expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    await annotate(interactionProfileAnnotation("trackpad pan handoff", p99), "performance");
    harness.navigation.dispose();
  });

  it("keeps horizontal touch momentum within budget", async ({ annotate }) => {
    const harness = createPanningHarness();
    const durations = measureInteractionFrames((frame) => {
      if (harness.frames.pending === 0) startFlick(harness, frame % 2 === 0 ? 1 : -1);
      harness.frames.flush();
    });

    const p99 = interactionP99(durations);
    expect(harness.cameraWrites).toBeGreaterThan(0);
    expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    await annotate(interactionProfileAnnotation("touch pan momentum", p99), "performance");
    harness.navigation.dispose();
  });
});

class FrameQueue {
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
    this.#time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
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

function startFlick(harness: ReturnType<typeof createNavigationHarness>, direction: number): void {
  const now = harness.frames.now;
  const step = INTERACTION_REFRESH_PROFILE.frameDurationMs;
  harness.navigation.recordTouchPan(direction * 8, now - step * 2);
  harness.navigation.recordTouchPan(direction * 8, now - step);
  harness.navigation.recordTouchPan(direction * 8, now);
  harness.navigation.releaseTouchPan(now);
}

function createPanningHarness(): ReturnType<typeof createNavigationHarness> {
  const harness = createNavigationHarness();
  expect(harness.navigation.restoreViewState({ cameraX: -100, zoom: 1 })).toBe(true);
  harness.resetWrites();
  return harness;
}

function createNavigationHarness() {
  const frames = new FrameQueue();
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
