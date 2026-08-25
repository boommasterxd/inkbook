import { vi } from "vitest";

import type { PageV1 } from "../../../../src/domain/schema/public";
import {
  ActiveEditorLayout,
  type ActiveEditorResizeUpdate,
} from "../../../../src/obsidian/embeds/active-editor/layout";
import type { SvgSceneRenderer } from "../../../../src/rendering/scene/index";
import { domRect } from "../../../fixtures/obsidian/active-editor";
import { FakeClassList } from "../../../fixtures/obsidian/class-list";

class ScheduledWork {
  readonly frames = new Map<number, FrameRequestCallback>();
  readonly motionQuery = new MotionQuery();
  #next = 1;
  #time = 0;

  readonly window = {
    cancelAnimationFrame: (id: number): void => void this.frames.delete(id),
    matchMedia: () => this.motionQuery,
    requestAnimationFrame: (callback: FrameRequestCallback): number => {
      const id = this.#next++;
      this.frames.set(id, callback);
      return id;
    },
  };

  flushFrame(): void {
    const entry = this.frames.entries().next().value;
    if (entry === undefined) throw new Error("No animation frame is pending.");
    this.frames.delete(entry[0]);
    this.#time += 16;
    entry[1](this.#time);
  }

  flushFrames(): void {
    while (this.frames.size > 0) this.flushFrame();
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

export function page(): PageV1 {
  return {
    activeBufferLines: 3,
    background: { type: "lines", spacing: 100 },
    innerWidth: 2000,
    lockedBufferLines: 1,
    margin: 24.3,
    writingLineHeight: 100,
  };
}

export function layoutHarness(motion: "full" | "reduced" | "system" = "full", horizontalInset = 0) {
  const work = new ScheduledWork();
  const observers = installLayoutObservers(work.window, horizontalInset);
  const rect = { height: 0, width: 1_000 };
  const styleProperties = new Map<string, string>();
  const style = layoutStyle(rect, styleProperties);
  const ownerDocument = { defaultView: work.window };
  const classList = new FakeClassList();
  const container = {
    classList,
    getBoundingClientRect: () =>
      domRect({ height: rect.height, left: 0, top: 0, width: rect.width }),
    ownerDocument,
    style,
  } as unknown as HTMLElement;
  const invalidateLayout = vi.fn();
  let scenePending = false;
  let pageChangesBecomePending = false;
  let rendererPageHeight: number | undefined;
  const setPage = vi.fn((_page: PageV1, height?: number) => {
    if (height === undefined || height === rendererPageHeight) return;
    rendererPageHeight = height;
    if (pageChangesBecomePending) scenePending = true;
  });
  const renderer = {
    get hasPendingSceneCommit() {
      return scenePending;
    },
    invalidateLayout,
    setCamera: vi.fn(),
    setPage,
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
    classList,
    invalidateLayout,
    layout,
    onLayout,
    onResize,
    onZoom,
    rect,
    setMaximumBottom: (value: number | undefined) => {
      maximumBottom = value;
    },
    setPage,
    setPageAvailable: (available: boolean) => {
      pageAvailable = available;
    },
    setPageChangesBecomePending: (enabled: boolean) => {
      pageChangesBecomePending = enabled;
    },
    setScenePending: (pending: boolean) => {
      scenePending = pending;
    },
    styleProperties,
    ...observers,
    work,
  };
}

function installLayoutObservers(ownerWindow: ScheduledWork["window"], horizontalInset: number) {
  let chromeMutation: MutationCallback | undefined;
  let resize: ResizeObserverCallback | undefined;
  Object.assign(ownerWindow, {
    getComputedStyle: () => computedStyle(horizontalInset),
    MutationObserver: class {
      public constructor(callback: MutationCallback) {
        chromeMutation = callback;
      }
      public disconnect(): void {}
      public observe(): void {}
    },
    ResizeObserver: class {
      public constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      public disconnect(): void {}
      public observe(): void {}
      public unobserve(): void {}
    },
  });
  return {
    triggerChromeMutation: () => chromeMutation?.([], {} as MutationObserver),
    triggerResize: () => resize?.([], {} as ResizeObserver),
  };
}

function layoutStyle(
  rect: { height: number },
  properties: Map<string, string>,
): CSSStyleDeclaration {
  return {
    get blockSize() {
      return `${String(rect.height)}px`;
    },
    set blockSize(value: string) {
      rect.height = Number.parseFloat(value);
    },
    removeProperty: (name: string) => void properties.delete(name),
    setProperty: (name: string, value: string) => void properties.set(name, value),
  } as unknown as CSSStyleDeclaration;
}

function computedStyle(horizontalInset: number): Partial<CSSStyleDeclaration> {
  return {
    borderBottomWidth: "0px",
    borderLeftWidth: horizontalInset > 0 ? "2px" : "0px",
    borderRightWidth: horizontalInset > 0 ? "2px" : "0px",
    borderTopWidth: "0px",
    paddingBottom: "0px",
    paddingLeft: horizontalInset > 0 ? `${String(horizontalInset / 2 - 2)}px` : "0px",
    paddingRight: horizontalInset > 0 ? `${String(horizontalInset / 2 - 2)}px` : "0px",
    paddingTop: "0px",
  };
}
