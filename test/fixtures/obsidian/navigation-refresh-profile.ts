import type { InputState } from "../../../src/editor/input/index";
import type { BrowserScrollElement } from "../../../src/obsidian/scrolling/index";
import type { SvgSceneRenderer } from "../../../src/rendering/scene/index";
import { domRect } from "./active-editor";
import { workSchedulerFromFrames } from "./work-scheduler";

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

export function startNavigationFlick(
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

function createProfileOwner(
  frames: FrameQueue,
  observe: (boundary: "viewport" | "bounds" | "height" | "scroll" | "scroll-read") => void,
): BrowserScrollElement {
  let scrollTop = 200;
  return {
    ownerDocument: {
      defaultView: {
        ...frames.window,
        getComputedStyle: () => ({ borderTopWidth: "1px", borderBottomWidth: "1px" }),
      },
      scrollingElement: null,
    },
    get clientHeight() {
      observe("viewport");
      return 500;
    },
    getBoundingClientRect: () => {
      observe("bounds");
      return domRect({ height: 500, left: 0, top: 0, width: 1_000 });
    },
    get scrollHeight() {
      observe("height");
      return 10_000;
    },
    get scrollTop() {
      observe("scroll-read");
      return scrollTop;
    },
    set scrollTop(value: number) {
      scrollTop = value;
      observe("scroll");
    },
  } as unknown as BrowserScrollElement;
}

export function buildNavigationHarness(api: NavigationProfileApi, refreshRate: number) {
  const { ActiveEditorNavigation, createInputState, OUTER_PAGE_WIDTH } = api;
  const frames = new FrameQueue(1000 / refreshRate);
  const rect = { height: 1_000, left: 0, top: 100, width: 1_000 };
  const activity: boolean[] = [];
  let cameraWrites = 0;
  let inputWrites = 0;
  let layoutWrites = 0;
  let scrollWrites = 0;
  let scrollReads = 0;
  let layoutReads = 0;
  let containerBoundsReads = 0;
  let ownerBoundsReads = 0;
  let scrollHeightReads = 0;
  let pageReads = 0;
  let input: InputState = createInputState({
    fitZoom: rect.width / OUTER_PAGE_WIDTH,
    zoom: rect.width / OUTER_PAGE_WIDTH,
  });
  const owner = createProfileOwner(frames, (boundary) => {
    if (boundary === "viewport") layoutReads += 1;
    else if (boundary === "bounds") ownerBoundsReads += 1;
    else if (boundary === "height") scrollHeightReads += 1;
    else if (boundary === "scroll-read") scrollReads += 1;
    else scrollWrites += 1;
  });
  const container = {
    getBoundingClientRect: () => {
      containerBoundsReads += 1;
      return domRect(rect);
    },
    ownerDocument: owner.ownerDocument,
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
      setCamera: () => cameraWrites++,
    } as unknown as SvgSceneRenderer,
    scrollOwner: owner,
    setInput: (next) => {
      inputWrites += 1;
      input = next;
    },
  });
  return {
    activity,
    inputWrites: () => inputWrites,
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
    get hostBoundsReads() {
      return { container: containerBoundsReads, owner: ownerBoundsReads };
    },
    navigation,
    owner,
    resetWrites: () => {
      inputWrites = 0;
      layoutReads = 0;
      containerBoundsReads = 0;
      ownerBoundsReads = 0;
      cameraWrites = 0;
      layoutWrites = 0;
      scrollWrites = 0;
      scrollReads = 0;
      scrollHeightReads = 0;
      pageReads = 0;
    },
    get scrollWrites() {
      return scrollWrites;
    },
    get scrollReads() {
      return scrollReads;
    },
  };
}
