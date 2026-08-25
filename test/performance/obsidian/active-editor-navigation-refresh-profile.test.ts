import { describe, expect, it } from "vitest";

import { createInputState, type InputState } from "../../../src/editor/input/index";
import { OUTER_PAGE_WIDTH } from "../../../src/editor/zoom/index";
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
import { timingBudget } from "../timing-budget";

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
    expect(p99).toBeLessThanOrEqual(timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms));
    await annotate(interactionProfileAnnotation("trackpad zoom", p99), "performance");
    harness.navigation.dispose();
  });

  it("keeps coalesced horizontal pan and native vertical scroll within budget", async ({
    annotate,
  }) => {
    const harness = createNavigationHarness();
    expect(harness.navigation.restoreViewState({ cameraX: -100, zoom: 1 })).toBe(true);
    harness.resetWrites();
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
    expect(p99).toBeLessThanOrEqual(timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms));
    await annotate(interactionProfileAnnotation("pan and native scroll", p99), "performance");
    harness.navigation.dispose();
  });
});

class FrameQueue {
  readonly #callbacks = new Map<number, FrameRequestCallback>();
  #handle = 0;
  #time = 0;

  public readonly window = {
    cancelAnimationFrame: (handle: number) => this.#callbacks.delete(handle),
    innerHeight: 800,
    innerWidth: 1_200,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      this.#handle += 1;
      this.#callbacks.set(this.#handle, callback);
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
  const ownerDocument = { defaultView: frames.window, scrollingElement: null };
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
      rect.height = blockSize;
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
