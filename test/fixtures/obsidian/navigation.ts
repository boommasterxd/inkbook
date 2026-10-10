import { vi } from "vitest";
import { createInputState, type InputState } from "../../../src/editor/input/index";
import { OUTER_PAGE_WIDTH } from "../../../src/editor/zoom/zoom";
import {
  ActiveEditorNavigation,
  type ActiveEditorZoomLayoutUpdate,
} from "../../../src/obsidian/embeds/active-editor/navigation";
import type { BrowserScrollElement } from "../../../src/obsidian/scrolling/index";
import type { SvgSceneRenderer } from "../../../src/rendering/scene/index";
import { domRect } from "./active-editor";
import { workSchedulerFromFrames } from "./work-scheduler";

export interface MutableRect {
  height: number;
  left: number;
  top: number;
  width: number;
}

export interface NavigationHarness {
  readonly containerRect: MutableRect;
  readonly frames: FrameHarness;
  readonly layoutUpdates: ActiveEditorZoomLayoutUpdate[];
  readonly navigation: ActiveEditorNavigation;
  readonly owner: BrowserScrollElement;
  readonly sequence: string[];
  readonly setCamera: ReturnType<typeof vi.fn>;
  readonly state: () => InputState;
}

export class FrameHarness {
  readonly #callbacks = new Map<number, FrameRequestCallback>();
  #nextFrame = 1;
  #time = 0;

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

  public get now(): number {
    return this.#time;
  }

  public flushOne(): void {
    const entry = this.#callbacks.entries().next().value as
      readonly [number, FrameRequestCallback] | undefined;
    if (entry === undefined) throw new Error("No animation frame is pending.");
    this.#callbacks.delete(entry[0]);
    this.#time += 16;
    entry[1](this.#time);
  }

  public flushAll(): void {
    while (this.#callbacks.size > 0) this.flushOne();
  }
}

export function createNavigationHarness(options?: {
  readonly activePageHeight?: number | (() => number);
  readonly blockInsets?: number;
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
    defaultView: {
      ...frames.window,
      getComputedStyle: () => ({
        borderTopWidth: `${String((options?.blockInsets ?? 0) / 2)}px`,
        borderBottomWidth: `${String((options?.blockInsets ?? 0) / 2)}px`,
      }),
    },
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
  const layoutUpdates: ActiveEditorZoomLayoutUpdate[] = [];
  const navigation = new ActiveEditorNavigation({
    workScheduler: workSchedulerFromFrames(frames.window),
    activePageHeight: () =>
      typeof options?.activePageHeight === "function"
        ? options.activePageHeight()
        : (options?.activePageHeight ?? 2_000),
    applyZoomLayout: (update) => {
      sequence.push("layout");
      layoutUpdates.push(update);
      containerRect.height = update.blockSize + (options?.blockInsets ?? 0);
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
