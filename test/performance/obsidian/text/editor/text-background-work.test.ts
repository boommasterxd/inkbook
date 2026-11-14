// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { TextEditorBackgroundLayer } from "../../../../../src/obsidian/text/editor/text-editor-background";
import { mountTextBackground } from "../../../../fixtures/obsidian/text-background";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("coalesces input, skips superseded measurements and releases pending ownership", async () => {
  const t = mountTextBackground();
  t.last.data = "c".repeat(199_994);
  Object.assign(t.view, { visibleRanges: [{ from: 2, to: 6 }] });
  const cornerEvaluation = vi.spyOn(Math, "cos");
  let base = t.base;
  const layer = new TextEditorBackgroundLayer(t.view, () => base);
  for (let i = 0; i < 100; i++) layer.invalidate();
  expect(t.frames.pendingCount).toBe(0);
  expect(t.requestMeasure).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 100; i++) layer.invalidate();
  const current = t.measures.shift()!;
  current.write(current.read());
  t.flush();
  await layer.ready;
  expect(t.requestMeasure).toHaveBeenCalledTimes(1);
  expect(t.targetReads).toHaveBeenCalledOnce();
  expect(t.rangeReads).toHaveBeenCalledOnce();
  expect(t.collapsedReads).toHaveBeenCalledTimes(2);
  const svg = t.dom.querySelector(".inkbook-text-editor-background")!;
  // Four mask-definition nodes plus one base path and one visible inline paint group.
  expect(svg.querySelectorAll("*")).toHaveLength(6);
  expect(svg.querySelectorAll(":scope > path")).toHaveLength(2);
  // Only the four field corners need circular geometry; source length adds no work.
  expect(cornerEvaluation).toHaveBeenCalled();
  expect(cornerEvaluation.mock.calls.length).toBeLessThanOrEqual(40);
  base = { ...base, width: 140 };
  t.dom.style.width = "140px";
  const writes = vi.spyOn(Element.prototype, "setAttribute");
  layer.invalidate();
  layer.publishGeometry(window.getComputedStyle(t.dom));
  expect(t.dom.querySelector("path")?.getAttribute("d")).toContain("140");
  expect(t.targetReads).toHaveBeenCalledTimes(2);
  // The width changes the two mask boxes, outer contour, and clipped inline/base paths only.
  expect(writes.mock.calls.length).toBeLessThanOrEqual(6);
  expect(svg.querySelectorAll("*")).toHaveLength(6);
  writes.mockClear();
  t.flush();
  expect(writes).not.toHaveBeenCalled();
  expect(t.targetReads).toHaveBeenCalledTimes(2);
  expect(t.rangeReads).toHaveBeenCalledTimes(2);
  layer.invalidate();
  layer.dispose();
  expect(svg.isConnected).toBe(false);
  expect(t.dom.querySelector("mask")).toBeNull();
  expect(t.frames.pendingCount).toBe(0);
  layer.invalidate();
  expect(t.frames.pendingCount).toBe(0);
});
