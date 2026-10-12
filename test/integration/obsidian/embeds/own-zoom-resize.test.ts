import { expect, it } from "vitest";
import { ownZoomResizeFixture } from "../../../fixtures/obsidian/own-zoom-resize";
import { readNavigationLayout } from "../../../../src/obsidian/embeds/active-editor/navigation-layout";
import type { BrowserScrollElement } from "../../../../src/obsidian/scrolling";

it("consumes only a validated own projected resize and keeps later external height changes", () => {
  const { h, zoom, notify, reset, read, box, ownerBox } = ownZoomResizeFixture();
  zoom(200);
  reset();
  notify(240);
  expect(h.invalidateLayout).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledOnce();
  expect(box).toHaveBeenCalledOnce();
  expect(ownerBox).toHaveBeenCalledOnce();
  notify(260);
  expect(h.invalidateLayout).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledOnce();
  h.layout.dispose();
});

it.each(["position", "clamp", "width", "height", "owner", "viewport", "window"])(
  "preserves invalidation for an external %s change during an own zoom",
  (change) => {
    const { h, zoom, notify, reset, read, owner, bounds } = ownZoomResizeFixture();
    zoom(200);
    if (change === "position") bounds.top += 10;
    if (change === "clamp") owner.scrollTop = 5;
    if (change === "width") h.rect.width = 900;
    if (change === "height") h.rect.height = 190;
    if (change === "viewport") Object.assign(owner, { clientHeight: 450 });
    if (change === "window") {
      const otherWindow = { ...h.container.ownerDocument.defaultView };
      Object.assign(h.container.ownerDocument, { defaultView: otherWindow });
    }
    if (change === "owner") {
      const other = { ...owner } as BrowserScrollElement;
      read.mockImplementation(() => readNavigationLayout(h.container, other));
    }
    reset();
    notify(240);
    expect(h.invalidateLayout).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    notify(240);
    expect(h.invalidateLayout).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledOnce();
    h.layout.dispose();
  },
);

it.each(["width", "unrelated", "invalid", "unknown", "unprojected"])(
  "rejects a %s observer report before performing a host validation read",
  (change) => {
    const { h, zoom, notify, reset, read } = ownZoomResizeFixture();
    zoom(200);
    if (change === "unprojected") h.layout.applyZoom({ blockSize: 300, zoom: 1 });
    reset();
    if (change === "unrelated") h.triggerResize([{ target: {} } as ResizeObserverEntry]);
    else if (change === "unknown") h.triggerResize();
    else notify(change === "invalid" ? Number.NaN : 240, change === "width" ? 900 : 1000);
    expect(h.invalidateLayout).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    h.layout.dispose();
  },
);

it("combines coalesced own height writes but rejects an unadopted projection", () => {
  const { h, zoom, notify, reset, read } = ownZoomResizeFixture();
  zoom(200);
  zoom(300);
  reset();
  notify(340);
  expect(h.invalidateLayout).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledOnce();
  const before = read()!;
  h.layout.applyZoom({ blockSize: 400, zoom: 1, layout: before });
  reset();
  notify(440);
  expect(h.invalidateLayout).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
  h.layout.dispose();
});
