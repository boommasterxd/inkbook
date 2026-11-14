// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleTextTableRows } from "../../../../../src/obsidian/text/editor/text-table-visible-rows";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function mount(rect: DOMRect, matrix?: { a: number; b: number; c: number; d: number }) {
  const foreign = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
  const clip = document.createElement("div");
  clip.className = "inkbook-text-editor-viewport";
  const widget = document.createElement("div");
  clip.append(widget);
  foreign.append(clip);
  document.body.append(foreign);
  vi.spyOn(clip, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 100));
  vi.spyOn(widget, "getBoundingClientRect").mockReturnValue(rect);
  Object.defineProperty(foreign, "getScreenCTM", {
    value: () => (matrix ? { ...matrix, e: 0, f: 0 } : null),
  });
  return widget;
}

describe("canonical table viewport coordinates", () => {
  it("finds far rows logarithmically using the public native scale when no SVG matrix exists", () => {
    const widget = mount(new DOMRect(0, -16_000, 400, 40_000));
    let reads = 0;
    const offsets = Array.from({ length: 1_001 }, (_, index) => index * 20);
    for (let index = 0; index < offsets.length; index += 1) {
      const value = offsets[index];
      Object.defineProperty(offsets, index, {
        get: () => {
          reads += 1;
          return value;
        },
      });
    }
    expect(visibleTextTableRows({ scaleX: 2, scaleY: 2 }, widget, 200, offsets)).toEqual({
      from: 398,
      to: 405,
    });
    expect(reads).toBeLessThan(30);
  });

  it("retains every intersecting row under a rotated zoomed SVG transform", () => {
    const widget = mount(new DOMRect(-3_600, 0, 4_000, 400), { a: 0, b: 2, c: -2, d: 0 });
    const offsets = Array.from({ length: 101 }, (_, index) => index * 20);
    expect(visibleTextTableRows({ scaleX: 1, scaleY: 1 }, widget, 200, offsets)).toEqual({
      from: 3,
      to: 13,
    });
  });

  it("returns no rows for a completely offscreen table or an empty owning clip", () => {
    const widget = mount(new DOMRect(0, -3_000, 200, 2_000));
    const offsets = Array.from({ length: 101 }, (_, index) => index * 20);
    expect(visibleTextTableRows({ scaleX: 1, scaleY: 1 }, widget, 200, offsets)).toEqual({
      from: 0,
      to: 0,
    });
    vi.spyOn(widget.parentElement!, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 0, 0),
    );
    expect(visibleTextTableRows({ scaleX: 1, scaleY: 1 }, widget, 200, offsets)).toEqual({
      from: 0,
      to: 0,
    });
  });
});
