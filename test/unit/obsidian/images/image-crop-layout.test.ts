// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { ImageCropLayout } from "../../../../src/obsidian/images/image-crop-layout";
import { imageElement } from "../../../fixtures/domain/images";

it("places a crop panel with its warning below the image when there is too little space above", () => {
  const host = document.createElement("div");
  const canvas = document.createElement("div");
  const outline = document.createElement("div");
  const panel = document.createElement("div");
  host.append(canvas, outline, panel);
  document.body.append(host);
  vi.spyOn(panel, "offsetWidth", "get").mockReturnValue(240);
  vi.spyOn(panel, "offsetHeight", "get").mockReturnValue(104);
  let top = 260;
  const canvasReads = vi
    .spyOn(canvas, "getBoundingClientRect")
    .mockImplementation(() => new DOMRect(21, top, 318, 340));
  const hostReads = vi
    .spyOn(host, "getBoundingClientRect")
    .mockImplementation(() => new DOMRect(20, top - 60, 320, 400));
  const image = {
    ...imageElement(),
    x: 300,
    y: 220,
    width: 1200,
    height: 900,
    pivot: { x: 900, y: 670 },
    crop: { x: 0, y: 0, width: 800, height: 600 },
  };
  const layout = new ImageCropLayout(canvas, image, host, panel);
  layout.setCamera({ x: 0, zoom: 0.145 });
  layout.update({ x: 120, y: 72, width: 680, height: 528 }, outline);
  const translateY = (element: HTMLElement) =>
    Number(element.style.transform.match(/translate\([^,]+, ([\d.-]+)px\)/)![1]);
  const imageBottom = translateY(outline) + Number.parseFloat(outline.style.height);
  expect(translateY(panel)).toBeGreaterThanOrEqual(imageBottom + 22);
  expect(translateY(panel) + panel.offsetHeight).toBeLessThanOrEqual(400);
  const pointer = { clientX: 21 + 300 * 0.145, clientY: top + 220 * 0.145 };
  expect(layout.sourcePoint(pointer).x).toBeCloseTo(0);
  expect(layout.sourcePoint(pointer).y).toBeCloseTo(0);
  expect(canvasReads).toHaveBeenCalledOnce();
  expect(hostReads).toHaveBeenCalledOnce();
  top -= 100;
  layout.measure();
  const scrolled = layout.sourcePoint({ ...pointer, clientY: pointer.clientY - 100 });
  expect(scrolled.x).toBeCloseTo(0);
  expect(scrolled.y).toBeCloseTo(0);
  expect(canvasReads).toHaveBeenCalledTimes(2);
  expect(hostReads).toHaveBeenCalledTimes(2);
  host.remove();
});
