// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import {
  createPhoneSheetSwipeHarness,
  touchPointer,
} from "../../../fixtures/obsidian/phone-sheet-swipe";

beforeEach(() => installObsidianDomHelpers());
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function setup() {
  const fixture = createPhoneSheetSwipeHarness(220);
  const captured = new Set<number>();
  const capture = vi.fn((id: number) => {
    captured.add(id);
  });
  const release = vi.fn((id: number) => {
    captured.delete(id);
    fixture.surface.dispatchEvent(touchPointer("lostpointercapture", 0, id, 0));
  });
  Object.assign(fixture.surface, {
    setPointerCapture: capture,
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: release,
  });
  return { ...fixture, capture, release, captured };
}

describe("phone swipe pointer ownership", () => {
  it("continues through the child's implicit capture transfer and stale surface loss", () => {
    const fixture = setup();
    fixture.handle.dispatchEvent(touchPointer("pointerdown", 100, 1, 0));
    expect(fixture.capture).toHaveBeenCalledExactlyOnceWith(1);
    fixture.handle.dispatchEvent(touchPointer("lostpointercapture", 100, 1, 1));
    fixture.surface.dispatchEvent(touchPointer("lostpointercapture", 100, 1, 2));
    fixture.surface.dispatchEvent(touchPointer("pointermove", 160, 1, 100));
    fixture.frames.flush();
    expect(fixture.surface.dataset.swipeState).toBe("dragging");
    expect(fixture.surface.style.translate).toBe("0 60px");
    fixture.controller.dispose();
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(1);
    expect(fixture.frames.pending).toBe(0);
  });

  it("settles when its own capture is actually lost", () => {
    const fixture = setup();
    fixture.handle.dispatchEvent(touchPointer("pointerdown", 100, 1, 0));
    fixture.surface.dispatchEvent(touchPointer("pointermove", 140, 1, 100));
    fixture.captured.delete(1);
    fixture.surface.dispatchEvent(touchPointer("lostpointercapture", 140, 1, 101));
    expect(fixture.surface.dataset.swipeState).toBe("settling");
    expect(fixture.surface.style.translate).toBe("0 40px");
    fixture.controller.dispose();
    expect(fixture.release).not.toHaveBeenCalled();
  });

  it.each(["pointerup", "pointercancel"])(
    "releases once on %s without restarting a gesture",
    (type) => {
      const fixture = setup();
      fixture.handle.dispatchEvent(touchPointer("pointerdown", 100, 1, 0));
      fixture.surface.dispatchEvent(touchPointer("pointermove", 140, 1, 100));
      fixture.surface.dispatchEvent(touchPointer(type, 140, 1, 300));
      expect(fixture.release).toHaveBeenCalledExactlyOnceWith(1);
      expect(fixture.frames.pending).toBe(1);
      expect(fixture.surface.dataset.swipeState).toBe("settling");
      fixture.controller.dispose();
      fixture.controller.dispose();
      expect(fixture.release).toHaveBeenCalledOnce();
      expect(fixture.frames.pending).toBe(0);
    },
  );

  it("captures only claimed downward gestures and ignores a second pointer", () => {
    const fixture = setup();
    fixture.scroll.scrollTop = 10;
    fixture.surface.dispatchEvent(touchPointer("pointerdown", 100, 1, 0));
    fixture.surface.dispatchEvent(touchPointer("pointermove", 150, 1, 50));
    fixture.scroll.scrollTop = 0;
    fixture.surface.dispatchEvent(touchPointer("pointerdown", 100, 2, 100));
    fixture.surface.dispatchEvent(touchPointer("pointermove", 102, 2, 110));
    expect(fixture.capture).not.toHaveBeenCalled();
    fixture.surface.dispatchEvent(touchPointer("pointermove", 140, 2, 150));
    fixture.surface.dispatchEvent(touchPointer("pointerdown", 100, 3, 160));
    fixture.surface.dispatchEvent(touchPointer("pointercancel", 100, 3, 170));
    expect(fixture.capture).toHaveBeenCalledExactlyOnceWith(2);
    expect(fixture.surface.dataset.swipeState).toBe("dragging");
    fixture.controller.dispose();
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("cleans up a gesture if native capture is unavailable for its pointer", () => {
    const fixture = setup();
    fixture.capture.mockImplementation(() => {
      throw new DOMException("Inactive pointer", "NotFoundError");
    });
    expect(() =>
      fixture.handle.dispatchEvent(touchPointer("pointerdown", 100, 1, 0)),
    ).not.toThrow();
    fixture.controller.dispose();
    expect(fixture.release).not.toHaveBeenCalled();
  });
});
