import { describe, expect, it, vi } from "vitest";

import type { PageV1 } from "../../../../src/domain/schema/public";
import { ActiveEditorLayout } from "../../../../src/obsidian/embeds/active-editor/layout";
import type { SvgSceneRenderer } from "../../../../src/rendering/scene/index";
import { domRect } from "../../../fixtures/obsidian/active-editor";
import { FakeClassList } from "../../../fixtures/obsidian/class-list";

describe("active editor responsive layout", () => {
  it("skips toolbar reads for repeated chrome keys and non-width content updates", () => {
    const fixture = responsiveFixture();
    fixture.layout.chromeMounted();
    fixture.flushFrames();
    const initialReads = fixture.toolbarReads();

    fixture.layout.chromeChanged("wide:right:no-finger:no-selection:no-paste");
    fixture.flushFrames();
    const keyedReads = fixture.toolbarReads();
    expect(keyedReads).toBeGreaterThan(initialReads);

    fixture.layout.chromeChanged("wide:right:no-finger:no-selection:no-paste");
    fixture.layout.contentChanged();
    fixture.flushFrames();
    expect(fixture.toolbarReads()).toBe(keyedReads);
    fixture.layout.dispose();
  });

  it("remeasures the toolbar directly when its geometry changes at a fixed page width", () => {
    const fixture = responsiveFixture();
    fixture.layout.chromeMounted();
    fixture.flushFrames();

    expect(fixture.onLayout).toHaveBeenLastCalledWith("wide");
    expect(fixture.observed.has(fixture.root)).toBe(true);
    expect(fixture.observed.has(fixture.toolbar())).toBe(true);

    fixture.setToolbarWidth(900);
    fixture.triggerResize();
    fixture.flushFrames();

    expect(fixture.onLayout).toHaveBeenLastCalledWith("scrollable");
    fixture.layout.dispose();
  });

  it("keeps a centered wide toolbar when context-action geometry changes", () => {
    const fixture = responsiveFixture();
    fixture.layout.chromeMounted();
    fixture.flushFrames();

    expect(fixture.onLayout).toHaveBeenLastCalledWith("wide");
    fixture.triggerContextMutation();
    fixture.flushFrames();

    expect(fixture.onLayout).toHaveBeenLastCalledWith("wide");
    fixture.layout.dispose();
  });
});

function responsiveFixture() {
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
  const layout = new ActiveEditorLayout({
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
      invalidateLayout: vi.fn(),
      setCamera: vi.fn(),
      setPage: vi.fn(),
    } as unknown as SvgSceneRenderer,
    root,
    storeMaximumBottom: () => undefined,
  });
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
  };
}

interface ResponsiveCallbacks {
  mutation?: MutationCallback;
  resize?: ResizeObserverCallback;
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
