import { expect, it } from "vitest";
import { ownZoomScrollFixture } from "../../../../../fixtures/obsidian/own-zoom-scroll";
import { OwnZoomScrollProof } from "../../../../../../src/obsidian/embeds/active-editor/layout/own-zoom-scroll";
import {
  projectNavigationCursorLayout,
  readNavigationLayout,
} from "../../../../../../src/obsidian/embeds/active-editor/navigation/navigation-layout";
import type { BrowserScrollElement } from "../../../../../../src/obsidian/scrolling";

it("consumes an own scroll once while retaining measured content insets", () => {
  const h = ownZoomScrollFixture();
  try {
    h.zoom();
    h.reset();
    h.scroll();
    expect(h.onScroll).toHaveBeenCalledOnce();
    expect(h.invalidate).not.toHaveBeenCalled();
    expect(h.fullRead).not.toHaveBeenCalled();
    expect(h.style).not.toHaveBeenCalled();
    expect(h.box).toHaveBeenCalledOnce();
    expect(h.ownerBox).toHaveBeenCalledOnce();
    h.scroll();
    expect(h.fullRead).toHaveBeenCalledOnce();
    expect(h.style).toHaveBeenCalledOnce();
  } finally {
    h.dispose();
  }
});

it.each(["position", "width", "owner position", "owner width", "scroll", "dirty scene"])(
  "freshly measures a %s change even when the old scroll report arrives",
  (change) => {
    const h = ownZoomScrollFixture();
    try {
      h.zoom();
      if (change === "position") h.origin.top += 20;
      if (change === "width") h.h.rect.width += 20;
      if (change === "owner position") h.ownerBounds.top += 20;
      if (change === "owner width") Object.defineProperty(h.owner, "clientWidth", { value: 900 });
      if (change === "scroll") h.owner.scrollTop += 20;
      if (change === "dirty scene") h.h.renderer.invalidateLayout();
      h.reset();
      h.scroll();
      expect(h.fullRead).toHaveBeenCalledOnce();
      expect(h.style).toHaveBeenCalledOnce();
      h.scroll();
      expect(h.fullRead).toHaveBeenCalledTimes(2);
    } finally {
      h.dispose();
    }
  },
);

it.each(["resize", "suspend", "dispose"])("discards a pending proof on %s", (change) => {
  const h = ownZoomScrollFixture();
  try {
    h.zoom();
    if (change === "resize") h.resize();
    if (change === "suspend") h.h.layout.suspend();
    if (change === "dispose") h.h.layout.dispose();
    h.reset();
    h.scroll();
    expect(h.fullRead).toHaveBeenCalledOnce();
    h.binding.dispose();
    h.reset();
    h.scroll();
    h.resize();
    expect(h.fullRead).not.toHaveBeenCalled();
    expect(h.onScroll).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});

it("freshly measures the transferred owner and detaches the previous owner's listener", () => {
  const h = ownZoomScrollFixture();
  const next = Object.assign(new EventTarget(), {
    ownerDocument: h.owner.ownerDocument,
    clientHeight: 500,
    clientWidth: 1000,
    scrollTop: 200,
    getBoundingClientRect: h.ownerBox,
  }) as unknown as BrowserScrollElement;
  try {
    h.zoom();
    h.reset();
    h.transfer(next);
    expect(h.fullRead).toHaveBeenCalledOnce();
    h.scroll();
    expect(h.fullRead).toHaveBeenCalledOnce();
    next.dispatchEvent(new Event("scroll"));
    expect(h.fullRead).toHaveBeenCalledTimes(2);
    h.binding.dispose();
    next.dispatchEvent(new Event("scroll"));
    expect(h.fullRead).toHaveBeenCalledTimes(2);
  } finally {
    h.dispose();
  }
});

it("rejects changed host geometry before any rectangle reads", () => {
  const h = ownZoomScrollFixture();
  let hostRevision = 0;
  const proof = new OwnZoomScrollProof({
    container: h.h.container,
    renderer: h.h.renderer,
    readHostGeometryRevision: () => hostRevision,
  });
  try {
    const before = readNavigationLayout(h.h.container, h.owner)!;
    proof.record(before, before.containerBounds.height);
    h.owner.scrollTop += 20;
    proof.adopt(
      projectNavigationCursorLayout(before, {
        blockSize: before.containerBounds.height,
        scrollTop: h.owner.scrollTop,
      }),
    );
    hostRevision += 1;
    h.reset();
    expect(proof.consume(h.owner)).toBe(false);
    expect(h.box).not.toHaveBeenCalled();
    expect(h.ownerBox).not.toHaveBeenCalled();
    expect(proof.consume(h.owner)).toBe(false);
  } finally {
    h.dispose();
  }
});

it.each(["detached", "foreign window"])(
  "rejects a %s projection before rectangle reads",
  (change) => {
    const h = ownZoomScrollFixture();
    try {
      h.zoom();
      if (change === "detached")
        Object.defineProperty(h.h.container, "isConnected", { value: false });
      else Object.defineProperty(h.owner, "ownerDocument", { value: { defaultView: {} } });
      h.reset();
      expect(h.h.layout.consumeOwnZoomScroll(h.owner)).toBe(false);
      expect(h.box).not.toHaveBeenCalled();
      expect(h.ownerBox).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  },
);

it("rejects missing border geometry, no-op scrolling, and mismatched projection", () => {
  const h = ownZoomScrollFixture();
  const proof = new OwnZoomScrollProof({ container: h.h.container, renderer: h.h.renderer });
  try {
    const before = readNavigationLayout(h.h.container, h.owner)!;
    proof.record(undefined, 200);
    proof.adopt(before);
    expect(proof.consume(h.owner)).toBe(false);
    const { containerBorderBounds: _border, ...withoutBorder } = before;
    proof.record(withoutBorder, 200);
    proof.adopt(before);
    expect(proof.consume(h.owner)).toBe(false);
    proof.record(before, before.containerBounds.height);
    proof.adopt(before);
    expect(proof.consume(h.owner)).toBe(false);
    proof.record(before, 200);
    proof.adopt({ ...before, scrollTop: before.scrollTop + 20 });
    expect(proof.consume(h.owner)).toBe(false);
  } finally {
    h.dispose();
  }
});
