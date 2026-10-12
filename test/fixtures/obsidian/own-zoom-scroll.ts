import { vi } from "vitest";
import {
  projectNavigationCursorLayout,
  readNavigationLayout,
} from "../../../src/obsidian/embeds/active-editor/navigation-layout";
import { bindActiveSceneScrollOwner } from "../../../src/obsidian/embeds/active-scene-scroll";
import { readActiveSceneLayout } from "../../../src/obsidian/embeds/active-scene-viewport";
import type { BrowserScrollElement } from "../../../src/obsidian/scrolling";
import { layoutHarness } from "../../integration/obsidian/embeds/active-editor-layout-fixture";
import { domRect } from "./active-editor";

export function ownZoomScrollFixture() {
  const h = layoutHarness("reduced", 12, 20);
  const windowEvents = new EventTarget();
  Object.assign(h.work.window, {
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
  });
  const document = h.container.ownerDocument;
  let version = 0;
  Object.defineProperty(h.renderer, "layoutInvalidationVersion", { get: () => version });
  h.invalidateLayout.mockImplementation(() => {
    version += 1;
  });
  const origin = { top: 300, left: 40 };
  const ownerBounds = { left: 10, top: 20, width: 1000, height: 500 };
  const ownerBox = vi.fn(() => domRect(ownerBounds));
  const owner = Object.assign(new EventTarget(), {
    ownerDocument: document,
    clientHeight: 500,
    clientWidth: 1000,
    scrollTop: 100,
    getBoundingClientRect: ownerBox,
  }) as unknown as BrowserScrollElement;
  const box = vi.spyOn(h.container, "getBoundingClientRect").mockImplementation(() =>
    inheritedRect({
      left: origin.left,
      top: origin.top - owner.scrollTop,
      width: h.rect.width,
      height: h.rect.height,
    }),
  );
  h.layout.chromeMounted();
  h.work.flushFrames();
  const style = vi.spyOn(h.work.window as unknown as Window, "getComputedStyle");
  const fullRead = vi.fn(() => readActiveSceneLayout(h.container, owner));
  const invalidate = vi.fn(() => {
    h.renderer.invalidateLayout();
    fullRead();
  });
  const onScroll = vi.fn();
  let liveOwner = owner;
  const binding = bindActiveSceneScrollOwner({
    initialOwner: owner,
    invalidate,
    onScroll,
    ownerWindow: h.work.window as unknown as Window,
    provider: () => liveOwner,
    reuseOwnScroll: (current) => h.layout.consumeOwnZoomScroll(current),
    root: { style: { setProperty: () => {} } } as unknown as HTMLElement,
    transfer: vi.fn(),
  });
  const zoom = (height = 200, scrollTop = 200) => {
    const before = readNavigationLayout(h.container, owner)!;
    const blockSize = h.layout.applyZoom({
      blockSize: height,
      zoom: height / h.layout.currentPageHeight()!,
      layout: before,
    });
    owner.scrollTop = scrollTop;
    h.layout.adoptNavigationLayout(projectNavigationCursorLayout(before, { blockSize, scrollTop }));
  };
  const reset = () => {
    box.mockClear();
    ownerBox.mockClear();
    style.mockClear();
    fullRead.mockClear();
    invalidate.mockClear();
    onScroll.mockClear();
  };
  const dispose = () => {
    binding.dispose();
    h.layout.dispose();
    box.mockRestore();
    style.mockRestore();
  };
  reset();
  return {
    h,
    owner,
    ownerBox,
    ownerBounds,
    origin,
    box,
    style,
    fullRead,
    invalidate,
    onScroll,
    binding,
    zoom,
    reset,
    dispose,
    scroll: () => owner.dispatchEvent(new Event("scroll")),
    resize: () => windowEvents.dispatchEvent(new Event("resize")),
    transfer: (next: BrowserScrollElement) => {
      liveOwner = next;
      binding.current();
    },
  };
}

/** DOMRect coordinates are inherited browser accessors, rather than spreadable fields. */
function inheritedRect(bounds: Parameters<typeof domRect>[0]): DOMRect {
  return Object.create(domRect(bounds)) as DOMRect;
}
