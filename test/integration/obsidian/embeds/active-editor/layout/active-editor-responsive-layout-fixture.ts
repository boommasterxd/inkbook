import { vi } from "vitest";
import type { PageV1 } from "../../../../../../src/domain/schema/public";
import { ActiveEditorLayout } from "../../../../../../src/obsidian/embeds/active-editor/layout/layout";
import type { SvgSceneRenderer } from "../../../../../../src/rendering/scene/index";
import { domRect } from "../../../../../fixtures/obsidian/active-editor";
import { FakeClassList } from "../../../../../fixtures/obsidian/class-list";
import { workSchedulerFromFrames } from "../../../../../fixtures/obsidian/work-scheduler";

interface ResponsiveFixtureOptions {
  readonly invalidateLayout?: () => void;
}

export function responsiveFixture(options: ResponsiveFixtureOptions = {}) {
  const frames = new Map<number, FrameRequestCallback>();
  const observed = new Set<Element>();
  let frameTime = 0;
  const callbacks: ResponsiveCallbacks = {};
  let toolbarReads = 0;
  let toolbarWidth = 554;
  const track = {
    get scrollWidth() {
      toolbarReads += 1;
      return toolbarWidth;
    },
  } as unknown as HTMLElement;
  const toolbar = {
    querySelector: (selector: string) => (selector === ".inkbook-toolbar-track" ? track : null),
    scrollWidth: 570,
  } as unknown as HTMLElement;
  const ownerWindow = responsiveOwnerWindow({ callbacks, frames, observed });
  const ownerDocument = { defaultView: ownerWindow } as unknown as Document;
  const root = { ownerDocument } as unknown as HTMLElement;
  const rect = { height: 0, width: 700 };
  const style = {
    get blockSize() {
      return `${String(rect.height)}px`;
    },
    set blockSize(value: string) {
      rect.height = Number.parseFloat(value);
    },
    removeProperty: vi.fn(),
    setProperty: vi.fn(),
  } as unknown as CSSStyleDeclaration;
  const container = {
    classList: new FakeClassList(),
    getBoundingClientRect: () =>
      domRect({ height: rect.height, left: 0, top: 0, width: rect.width }),
    ownerDocument,
    style,
  } as unknown as HTMLElement;
  const chromeHost = {
    querySelector: (selector: string) => (selector === ".inkbook-toolbar" ? toolbar : null),
  } as unknown as HTMLElement;
  const onLayout = vi.fn();
  const invalidateLayout = vi.fn();
  const layout = new ActiveEditorLayout({
    workScheduler: workSchedulerFromFrames(ownerWindow),
    chromeHost,
    container,
    onLayout,
    onReady: vi.fn(),
    onZoom: vi.fn(),
    page,
    renderer: {
      get hasPendingSceneCommit() {
        return false;
      },
      invalidateLayout: options.invalidateLayout ?? invalidateLayout,
      setCamera: vi.fn(),
      setPage: vi.fn(),
    } as unknown as SvgSceneRenderer,
    root,
    storeMaximumBottom: () => undefined,
  });
  const prepareRootResize = rootResizePreparation(callbacks, root, rect);
  return {
    flushFrames: () => {
      while (frames.size > 0) {
        const [id, callback] = frames.entries().next().value!;
        frames.delete(id);
        frameTime += 16;
        callback(frameTime);
      }
    },
    layout,
    invalidateLayout,
    observed,
    onLayout,
    root,
    triggerContextMutation: () => {
      callbacks.mutation?.([], {} as MutationObserver);
    },
    setToolbarWidth: (width: number) => {
      toolbarWidth = width;
      callbacks.mutation?.([], {} as MutationObserver);
    },
    toolbar: () => toolbar,
    toolbarReads: () => toolbarReads,
    triggerResize: () => callbacks.resize?.([], {} as ResizeObserver),
    prepareRootResize,
    triggerRootResize: (width: number, height: number) => prepareRootResize(width, height)(),
    triggerToolbarResize: () =>
      callbacks.resize?.(
        [{ target: toolbar } as unknown as ResizeObserverEntry],
        {} as ResizeObserver,
      ),
  };
}

interface ResponsiveCallbacks {
  mutation?: MutationCallback;
  resize?: ResizeObserverCallback;
}

function rootResizePreparation(
  callbacks: ResponsiveCallbacks,
  root: HTMLElement,
  rect: { width: number },
) {
  return (width: number, height: number) => {
    const entries = [resizeEntry(root, width, height)];
    const observer = {} as ResizeObserver;
    return () => {
      rect.width = width;
      callbacks.resize?.(entries, observer);
    };
  };
}

function responsiveOwnerWindow(options: {
  readonly callbacks: ResponsiveCallbacks;
  readonly frames: Map<number, FrameRequestCallback>;
  readonly observed: Set<Element>;
}) {
  let frameId = 0;
  return {
    MutationObserver: class {
      public constructor(callback: MutationCallback) {
        options.callbacks.mutation = callback;
      }
      public disconnect(): void {}
      public observe(): void {}
    },
    ResizeObserver: class {
      public constructor(callback: ResizeObserverCallback) {
        options.callbacks.resize = callback;
      }
      public disconnect(): void {
        options.observed.clear();
      }
      public observe(element: Element): void {
        options.observed.add(element);
      }
      public unobserve(element: Element): void {
        options.observed.delete(element);
      }
    },
    cancelAnimationFrame: (id: number) => void options.frames.delete(id),
    getComputedStyle: () => ({
      borderBottomWidth: "0px",
      borderLeftWidth: "0px",
      borderRightWidth: "0px",
      borderTopWidth: "0px",
      paddingBottom: "0px",
      paddingLeft: "0px",
      paddingRight: "0px",
      paddingTop: "0px",
    }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = ++frameId;
      options.frames.set(id, callback);
      return id;
    },
  };
}

function page(): PageV1 {
  return {
    activeBufferLines: 3,
    background: { type: "squares", spacing: 50 },
    innerWidth: 2000,
    lockedBufferLines: 1,
    margin: 24.3,
  };
}

function resizeEntry(target: HTMLElement, width: number, height: number): ResizeObserverEntry {
  return {
    target,
    contentBoxSize: [{ inlineSize: width, blockSize: height }],
    borderBoxSize: [{ inlineSize: width, blockSize: height }],
    devicePixelContentBoxSize: [{ inlineSize: width, blockSize: height }],
    contentRect: domRect({ width, height, left: 0, top: 0 }),
  };
}

export function readyResponsiveFixture(options: ResponsiveFixtureOptions = {}) {
  const fixture = responsiveFixture(options);
  fixture.layout.chromeMounted();
  fixture.triggerRootResize(700, 200);
  fixture.flushFrames();
  fixture.onLayout.mockClear();
  fixture.invalidateLayout.mockClear();
  return fixture;
}
