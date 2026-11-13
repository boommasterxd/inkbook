// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { TextEditingViewport } from "../../../../src/rendering/scene/text-editing-viewport";
import { textElement } from "../../../fixtures/rendering/text";
import { SVG_NAMESPACE } from "../../../../src/rendering/scene/constants";
import type { AffineMatrix } from "../../../../src/domain/geometry/affine-matrix";

it("windows long text in page coordinates through scrolling, zoom, EOF and cleanup", () => {
  const element = textElement({ x: 50, y: 100, height: 39_000, pivot: { x: 150, y: 19_600 } });
  const group = document.createElementNS(SVG_NAMESPACE, "g");
  const cameraGroup = document.createElementNS(SVG_NAMESPACE, "g");
  const clip = document.createElement("div");
  const container = document.createElement("div");
  clip.append(container);
  let camera = { x: 0, zoom: 1 };
  const matrix = () => ({
    a: camera.zoom,
    b: 0,
    c: 0,
    d: camera.zoom,
    e: camera.x * camera.zoom,
    f: 0,
  });
  const localRead = vi.fn(matrix);
  const cameraRead = vi.fn(matrix);
  Object.defineProperty(group, "getScreenCTM", { value: localRead });
  Object.defineProperty(cameraGroup, "getScreenCTM", { value: cameraRead });
  const changed = vi.fn();
  const invalidate = vi.fn();
  const viewport = { left: 0, top: 1_000, width: 800, height: 900 };
  const surface = new TextEditingViewport({
    text: { element, group },
    clip,
    container,
    bounds: element,
    context: { cameraGroup, viewport, camera, invalidate },
    onChanged: changed,
  });
  expect(clip.style.getPropertyValue("--inkbook-text-viewport-top")).toBe("900px");
  expect(clip.style.getPropertyValue("--inkbook-text-viewport-height")).toBe("900px");
  expect(container.style.getPropertyValue("--inkbook-text-editor-height")).toBe("39000px");
  expect(localRead).not.toHaveBeenCalled();
  surface.update(viewport, camera);
  surface.update(viewport, camera);
  expect(localRead).toHaveBeenCalledOnce();
  expect(cameraRead).toHaveBeenCalledOnce();
  camera = { x: -30, zoom: 2 };
  surface.update({ left: 0, top: 76_600, width: 800, height: 1_600 }, camera);
  expect(clip.style.getPropertyValue("--inkbook-text-viewport-top")).toBe("38200px");
  expect(clip.style.getPropertyValue("--inkbook-text-viewport-height")).toBe("800px");
  expect(surface.pageBounds({ left: 40, right: 60, top: 77_800, bottom: 77_820 })).toEqual({
    minX: 50,
    maxX: 60,
    minY: 38_900,
    maxY: 38_910,
  });
  surface.updateBounds({ ...element, height: 40_000 });
  expect(invalidate).toHaveBeenCalledOnce();
  expect(container.style.getPropertyValue("--inkbook-text-editor-height")).toBe("40000px");
  expect(surface.setContentHeight(124_000)).toEqual({
    minX: 50,
    maxX: 250,
    minY: 100,
    maxY: 124_100,
  });
  surface.updateBounds({ ...element, height: 41_000 });
  expect(container.style.getPropertyValue("--inkbook-text-editor-height")).toBe("124000px");
  expect(localRead).toHaveBeenCalledTimes(2);
  expect(cameraRead).toHaveBeenCalledTimes(2);
  expect(surface.setContentHeight(NaN)).toBeUndefined();
  expect(surface.setContentHeight(0)).toEqual({ minX: 50, maxX: 250, minY: 100, maxY: 41_100 });
  const count = changed.mock.calls.length;
  surface.release();
  surface.update(viewport, camera);
  expect(changed).toHaveBeenCalledTimes(count);
  expect(surface.pageBounds({ left: 0, right: 1, top: 0, bottom: 1 })).toBeUndefined();
  expect(surface.setContentHeight(1)).toBeUndefined();
});

it("uses public CTMs for a conservative rotated clip and world-space caret reveal", () => {
  const element = textElement({
    x: 0,
    y: 0,
    width: 400,
    height: 32_000,
    rotation: 90,
    pivot: { x: 200, y: 16_000 },
  });
  const group = document.createElementNS(SVG_NAMESPACE, "g");
  const cameraGroup = document.createElementNS(SVG_NAMESPACE, "g");
  const clip = document.createElement("div");
  const container = document.createElement("div");
  Object.defineProperty(group, "getScreenCTM", {
    value: () => ({ a: 0, b: 2, c: -2, d: 0, e: 32_400, f: 31_600 }),
  });
  Object.defineProperty(cameraGroup, "getScreenCTM", {
    value: () => ({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }),
  });
  const camera = { x: 0, zoom: 1 };
  const surface = new TextEditingViewport({
    text: { element, group },
    clip,
    container,
    bounds: element,
    context: { cameraGroup, camera, viewport: undefined, invalidate: () => undefined },
    onChanged: undefined,
  });
  surface.update({ left: 2_000, top: 31_600, width: 1_600, height: 800 }, camera);
  expect(clip.style.getPropertyValue("--inkbook-text-viewport-top")).toBe("14400px");
  expect(clip.style.getPropertyValue("--inkbook-text-viewport-height")).toBe("800px");
  expect(surface.pageBounds({ left: 2_000, right: 2_020, top: 31_800, bottom: 31_840 })).toEqual({
    minX: 1_000,
    maxX: 1_010,
    minY: 15_900,
    maxY: 15_920,
  });
  const extent = surface.setContentHeight(40_000)!;
  expect(extent.minX).toBeCloseTo(-23_800, 6);
  expect(extent.maxX).toBeCloseTo(16_200, 6);
  expect(extent.minY).toBeCloseTo(15_800, 6);
  expect(extent.maxY).toBeCloseTo(16_200, 6);
  surface.release();
});

it("refreshes only changed residual clipping and transforms retained source extent without native height reads", () => {
  const element = textElement({ x: 0, y: 0, height: 100, rotation: 0 });
  const group = document.createElementNS(SVG_NAMESPACE, "g");
  const clip = document.createElement("div"),
    container = document.createElement("div");
  const text = { element, group, previewMatrix: undefined as AffineMatrix | undefined };
  let scale = 1;
  const read = vi.fn(() => ({ a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 }));
  Object.defineProperty(group, "getScreenCTM", { value: read });
  const changed = vi.fn(),
    heightRead = vi.spyOn(container, "getBoundingClientRect");
  const surface = new TextEditingViewport({
    text,
    clip,
    container,
    bounds: element,
    context: undefined,
    onChanged: changed,
  });
  const viewport = { left: 0, top: 0, width: 200, height: 100 },
    camera = { x: 0, zoom: 1 };
  surface.update(viewport, camera);
  changed.mockClear();
  scale = 2;
  text.previewMatrix = [2, 0, 0, 2, 0, 0];
  group.setAttribute("transform", "scale(2)");
  surface.update(viewport, camera);
  expect(clip.style.getPropertyValue("--inkbook-text-viewport-height")).toBe("50px");
  expect(changed).toHaveBeenCalledExactlyOnceWith(false);
  surface.update(viewport, camera);
  expect(read).toHaveBeenCalledTimes(2);
  expect(surface.setContentHeight(300)).toEqual({ minX: 0, minY: 0, maxX: 400, maxY: 600 });
  expect(heightRead).not.toHaveBeenCalled();
  surface.release();
});

it("keeps an isolated long-source viewport local and maps caret coordinates through rotation and zoom", () => {
  const element = textElement({
    x: 0,
    y: 0,
    width: 400,
    height: 32000,
    rotation: 90,
    pivot: { x: 200, y: 16000 },
  });
  const group = document.createElementNS(SVG_NAMESPACE, "g"),
    cameraGroup = document.createElementNS(SVG_NAMESPACE, "g");
  const clip = document.createElement("div"),
    container = document.createElement("div");
  const read = vi.fn(() => ({ a: 0, b: 2, c: -2, d: 0, e: 32400, f: 31600 }));
  Object.defineProperty(group, "getScreenCTM", { value: read });
  Object.defineProperty(cameraGroup, "getScreenCTM", {
    value: () => ({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }),
  });
  const camera = { x: 0, zoom: 2 };
  const surface = new TextEditingViewport({
    text: { element, group },
    clip,
    container,
    isolatedInput: true,
    bounds: element,
    context: { cameraGroup, camera, viewport: undefined, invalidate: () => undefined },
    onChanged: undefined,
  });
  surface.update({ left: 2000, top: 31600, width: 1600, height: 800 }, camera);
  expect(clip.style.getPropertyValue("--inkbook-text-viewport-height")).toBe("800px");
  expect(container.style.getPropertyValue("--inkbook-text-viewport-top")).toBe("14400px");
  expect(container.style.getPropertyValue("--inkbook-text-editor-height")).toBe("32000px");
  surface.updateBounds({ ...element, width: 399.123 });
  expect(container.style.getPropertyValue("--inkbook-text-editor-width")).toBe("399.123px");
  const point = surface.toDrawingPoint({ x: 20, y: 30 })!;
  expect(point.x).toBeCloseTo(3540);
  expect(point.y).toBeCloseTo(31640);
  const local = surface.fromDrawingPoint(point)!;
  expect(local.x).toBeCloseTo(20);
  expect(local.y).toBeCloseTo(30);
  const bounds = surface.pageBounds({ left: 20, right: 40, top: 30, bottom: 50 })!;
  expect(bounds.minX).toBeCloseTo(1750);
  expect(bounds.maxX).toBeCloseTo(1770);
  expect(bounds.minY).toBeCloseTo(15820);
  expect(bounds.maxY).toBeCloseTo(15840);
  expect(read).toHaveBeenCalledOnce();
  surface.release();
  expect(surface.toDrawingPoint({ x: 0, y: 0 })).toBeUndefined();
  expect(surface.fromDrawingPoint(point)).toBeUndefined();
});
