import { vi } from "vitest";
import {
  projectNavigationCursorLayout,
  readNavigationLayout,
} from "../../../src/obsidian/embeds/active-editor/navigation-layout";
import type { BrowserScrollElement } from "../../../src/obsidian/scrolling";
import { layoutHarness } from "../../integration/obsidian/embeds/active-editor-layout-fixture";
import { domRect } from "./active-editor";

export function ownZoomResizeFixture() {
  const read = vi.fn(() => readNavigationLayout(h.container, owner));
  const h = layoutHarness("reduced", 0, 0, read);
  h.rect.height = 100;
  const bounds = { left: 0, top: 0, width: 1000, height: 500 };
  const ownerBox = vi.fn(() => domRect(bounds));
  const owner = {
    ownerDocument: h.container.ownerDocument,
    clientHeight: 500,
    clientWidth: 1000,
    scrollTop: 0,
    getBoundingClientRect: ownerBox,
  } as unknown as BrowserScrollElement;
  const box = vi.spyOn(h.container, "getBoundingClientRect");
  const notify = (height: number, width = 1000) =>
    h.triggerResize([
      {
        target: h.root,
        contentRect: domRect({ left: 0, top: 0, width, height }),
        borderBoxSize: [],
        contentBoxSize: [],
        devicePixelContentBoxSize: [],
      },
    ]);
  notify(140);
  const zoom = (height: number) => {
    const before = read()!;
    h.layout.applyZoom({ blockSize: height, zoom: 1, layout: before });
    h.layout.adoptNavigationLayout(
      projectNavigationCursorLayout(before, { blockSize: height, scrollTop: owner.scrollTop }),
    );
  };
  const reset = () => {
    h.invalidateLayout.mockClear();
    read.mockClear();
    box.mockClear();
    ownerBox.mockClear();
  };
  return { h, owner, ownerBox, bounds, box, read, notify, zoom, reset };
}
