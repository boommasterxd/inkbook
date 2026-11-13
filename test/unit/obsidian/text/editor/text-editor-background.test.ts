// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { mountTextBackground } from "../../../../fixtures/obsidian/text-background";
import {
  TextEditorBackgroundLayer,
  textBackgroundAttributes,
} from "../../../../../src/obsidian/text/editor/text-editor-background";
import { measureTextBackground } from "../../../../../src/obsidian/text/editor/text-background-measurement";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("keeps an atomic geometry paint when an earlier queued read writes afterward", () => {
  const t = mountTextBackground();
  let base = t.base;
  const layer = new TextEditorBackgroundLayer(t.view, () => base);
  const queued = t.measures.shift()!;
  const old = queued.read();
  base = { ...base, width: 140 };
  t.dom.style.width = "140px";
  layer.publishGeometry(window.getComputedStyle(t.dom));
  const path = t.dom.querySelector(".inkbook-text-editor-background > path")!;
  const current = path.getAttribute("d");
  expect(current).toContain("140");
  queued.write(old);
  expect(path.getAttribute("d")).toBe(current);
  expect(t.dom.querySelector("mask")?.getAttribute("width")).toBe("140");
  expect(t.targetReads).toHaveBeenCalledTimes(2);
  base = { ...base, width: 160 };
  t.dom.style.width = "160px";
  layer.invalidate();
  const pending = t.measures.shift()!;
  const previous = pending.read();
  layer.publishGeometry(window.getComputedStyle(t.dom));
  base = { ...base, width: 180 };
  t.dom.style.width = "180px";
  layer.invalidate();
  pending.write(previous);
  t.flush();
  expect(path.getAttribute("d")).toContain("180");
  expect(t.targetReads).toHaveBeenCalledTimes(5);
  layer.dispose();
});

it("replaces base alpha beneath the measured word instead of painting through it", async () => {
  const t = mountTextBackground();
  const layer = new TextEditorBackgroundLayer(t.view, () => t.base);
  t.flush();
  await layer.ready;
  const paths = [...t.dom.querySelectorAll(".inkbook-text-editor-background > path")];
  expect(paths).toHaveLength(2);
  expect(paths.map((p) => p.getAttribute("fill-opacity"))).toEqual(["0.7", "0.2"]);
  expect(paths[0]!.getAttribute("d")).toContain("A25 25 0 0 1");
  expect(paths[0]!.getAttribute("d")).not.toBe("M0 0H100V62.375H0Z");
  const mask = t.dom.querySelector("mask")!;
  expect(mask.getAttribute("mask-type")).toBe("luminance");
  expect(mask.getAttribute("maskUnits")).toBe("userSpaceOnUse");
  expect(mask.querySelector("rect")?.getAttribute("fill")).toBe("white");
  expect(mask.querySelector("path")?.getAttribute("fill")).toBe("black");
  expect(paths[0]!.getAttribute("mask")).toBe(`url(#${mask.id})`);
  expect(paths[1]!.hasAttribute("mask")).toBe(false);
  expect(mask.querySelector("path")!.getAttribute("d")).toContain("M20");
  t.word.removeAttribute("data-inkbook-text-background");
  layer.invalidate();
  t.flush();
  expect(paths[0]!.hasAttribute("mask")).toBe(false);
  expect(mask.querySelector("path")!.getAttribute("d")).toBe("");
  t.word.setAttribute("data-inkbook-text-background", "");
  t.word.setAttribute("data-inkbook-bg-color", "none");
  layer.invalidate();
  t.flush();
  expect(t.dom.querySelectorAll(".inkbook-text-editor-background > path")).toHaveLength(1);
  expect(measureTextBackground(t.view, t.base)!.rectangles[0]!.color).toBeNull();
  expect(mask.querySelector("path")!.getAttribute("d")).toContain("M20");
  expect(paths[0]!.getAttribute("mask")).toBe(`url(#${mask.id})`);
  layer.dispose();
  expect(t.dom.querySelector(".inkbook-text-editor-background")).toBeNull();
  expect(t.dom.classList.contains("inkbook-text-background-owner")).toBe(false);
});

it("unions overlapping same-alpha fragments into one paint and preserves rounded transparent cutouts", () => {
  const t = mountTextBackground();
  t.targetReads.mockReturnValue([
    new DOMRect(20, 4.6875, 40, 53),
    new DOMRect(30, 4.6875, 40, 53),
  ] as unknown as DOMRectList);
  const layer = new TextEditorBackgroundLayer(t.view, () => t.base);
  t.flush();
  const paints = t.dom.querySelectorAll(".inkbook-text-editor-background > path");
  expect(paints).toHaveLength(2);
  expect(paints[1]!.getAttribute("fill-opacity")).toBe("0.2");
  expect(paints[1]!.getAttribute("d")!.match(/M/gu)).toHaveLength(2);
  const cutouts = t.dom.querySelector("mask path")!;
  expect(cutouts.getAttribute("fill-rule")).toBe("nonzero");
  expect(paints[1]!.getAttribute("fill-rule")).toBe("nonzero");
  expect(cutouts.getAttribute("d")).toBe(paints[1]!.getAttribute("d"));
  t.word.setAttribute("data-inkbook-bg-color", "none");
  t.targetReads.mockReturnValue([new DOMRect(0, 4.6875, 100, 53)] as unknown as DOMRectList);
  layer.invalidate();
  t.flush();
  expect(t.dom.querySelectorAll(".inkbook-text-editor-background > path")).toHaveLength(1);
  expect(cutouts.getAttribute("d")).toContain("A25 25");
  layer.dispose();
});

it("measures only visible text ranges and preserves explicitly transparent metadata", () => {
  const t = mountTextBackground();
  Object.assign(t.view, { visibleRanges: [{ from: 2, to: 6 }] });
  const measured = measureTextBackground(t.view, t.base)!;
  expect(t.collapsedReads).toHaveBeenCalledTimes(2);
  expect(measured.rectangles).toHaveLength(1);
  expect(measured.rectangles[0]).toMatchObject({ x: 20, width: 40, opacity: 0.2 });
  expect(textBackgroundAttributes({ backgroundColor: null, backgroundOpacity: 0 })).toEqual({
    "data-inkbook-bg-color": "none",
    "data-inkbook-bg-opacity": "0",
    "data-inkbook-text-background": "",
  });
  expect(textBackgroundAttributes({ bold: true })).toEqual({});
});

it("keeps wrapped visual rows separate despite fractional native line rounding", () => {
  const t = mountTextBackground();
  t.word.textContent = "Bbbbbbbbbbbb";
  t.positions.set(t.word.firstChild!, 2);
  t.positions.set(t.last, 14);
  Object.assign(t.view, { visibleRanges: [{ from: 0, to: 18 }] });
  t.dom.style.height = "124.75px";
  const wrappedRects = [
    new DOMRect(20, 4.6875, 80, 53),
    new DOMRect(0, 67.0625, 40, 53),
  ] as unknown as DOMRectList;
  t.targetReads.mockReturnValue(wrappedRects);
  t.collapsedReads.mockImplementation(function (this: Range) {
    return new DOMRect(
      this.startContainer === t.last
        ? 40
        : (t.positions.get(this.startContainer)! + this.startOffset) * 10,
      this.startContainer === t.last ? 67.0625 : 4.6875,
      0,
      53,
    );
  });
  t.rangeReads.mockImplementation(function (this: Range) {
    if (this.startContainer === t.word.firstChild) return wrappedRects;
    return [
      new DOMRect(
        this.startContainer === t.last ? 40 : 0,
        this.startContainer === t.last ? 67.0625 : 4.6875,
        this.startContainer === t.last ? 40 : 20,
        53,
      ),
    ] as unknown as DOMRectList;
  });
  const rectangles = measureTextBackground(t.view, { ...t.base, height: 124.75 })!.rectangles;
  expect(rectangles).toHaveLength(2);
  expect(rectangles[0]!.height).toBeCloseTo(62.4);
  expect(rectangles[1]!.height).toBeCloseTo(62.4);
  expect(rectangles[1]!.y - rectangles[0]!.y).toBeCloseTo(62.375);
});

it("waits for preview decorations before making the first background authoritative", async () => {
  const t = mountTextBackground();
  let ready = false;
  const layer = new TextEditorBackgroundLayer(t.view, () => ({ ...t.base, ready }));
  let published = false;
  void layer.ready.then(() => {
    published = true;
  });
  t.flush();
  await Promise.resolve();
  expect(published).toBe(false);
  expect(t.targetReads).not.toHaveBeenCalled();
  ready = true;
  layer.invalidate();
  t.flush();
  await layer.ready;
  expect(published).toBe(true);
  layer.dispose();
});

it("keeps field padding inside the base paint while inline backgrounds follow inset glyphs", () => {
  const t = mountTextBackground();
  const padding = 8;
  t.dom.style.height = "78.375px";
  t.targetReads.mockReturnValue([
    new DOMRect(20 + padding, 4.6875 + padding, 40, 53),
  ] as unknown as DOMRectList);
  t.collapsedReads.mockImplementation(function (this: Range) {
    return new DOMRect(
      (t.positions.get(this.startContainer)! + this.startOffset) * 10 + padding,
      4.6875 + padding,
      0,
      53,
    );
  });
  t.rangeReads.mockImplementation(function (this: Range) {
    return [
      new DOMRect(
        (t.positions.get(this.startContainer)! + this.startOffset) * 10 + padding,
        4.6875 + padding,
        (this.endOffset - this.startOffset) * 10,
        53,
      ),
    ] as unknown as DOMRectList;
  });
  const measured = measureTextBackground(t.view, { ...t.base, height: 78.375 })!;
  expect(measured.box).toEqual({ x: 0, y: 0, width: 100, height: 78.375 });
  expect(measured.rectangles).toHaveLength(1);
  expect(measured.rectangles[0]).toMatchObject({ x: 28, width: 40 });
  expect(measured.rectangles[0]!.y).toBeCloseTo(padding - 0.0125);
});
