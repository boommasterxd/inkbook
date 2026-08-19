// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact gesture coordinates and scale ratios are the measured contract. */

import { describe, expect, it } from "vitest";

import { PhaseZeroViewZoom } from "../../../../src/adapters/obsidian/views/phase-zero-view-zoom";

function createZoom(): Readonly<{
  container: HTMLElement;
  svg: SVGSVGElement;
  zoom: PhaseZeroViewZoom;
}> {
  const container = document.createElement("div");
  Object.defineProperty(container, "getBoundingClientRect", {
    value: (): DOMRect => new DOMRect(10, 20, 300, 200),
  });
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  return { container, svg, zoom: new PhaseZeroViewZoom(container, svg) };
}

function readScale(svg: SVGSVGElement): number {
  const match = /scale\(([^)]+)\)$/u.exec(svg.style.transform);
  if (match?.[1] === undefined) throw new Error("Expected scale transform.");
  return Number(match[1]);
}

function wheel(deltaY: number, clientX = 110, clientY = 70): WheelEvent {
  return new WheelEvent("wheel", {
    cancelable: true,
    clientX,
    clientY,
    ctrlKey: true,
    deltaY,
  });
}

describe("PhaseZeroViewZoom", () => {
  it("applies every latest touch scale without changing the probe position", () => {
    const { svg, zoom } = createZoom();

    zoom.touch(1.1);
    expect(zoom.panX).toBe(0);
    expect(zoom.panY).toBe(0);
    expect(readScale(svg)).toBeCloseTo(1.21);

    zoom.touch(12 / 11);
    expect(zoom.panX).toBe(0);
    expect(zoom.panY).toBe(0);
    expect(readScale(svg)).toBeCloseTo(1.44);
    expect(zoom.zoomPercent).toBeCloseTo(144);
  });

  it("does not write a second transform for a duplicate touch sample", () => {
    const { svg, zoom } = createZoom();
    zoom.touch(1.08);
    const transform = svg.style.transform;

    zoom.touch(1);

    expect(svg.style.transform).toBe(transform);
    expect(readScale(svg)).toBeCloseTo(1.1664);
  });

  it("maps a 12-pixel touchpad delta to a responsive logarithmic scale", () => {
    const { svg, zoom } = createZoom();
    const event = wheel(-12);
    Object.defineProperty(event, "ctrlKey", { value: true });

    zoom.wheel(event);

    expect(event.defaultPrevented).toBe(true);
    expect(readScale(svg)).toBeCloseTo(Math.exp(0.12));
    expect(Math.log(readScale(svg))).toBeCloseTo(0.12);
  });

  it("handles alternating latest samples without a queue or lost delta", () => {
    const { svg, zoom } = createZoom();

    zoom.scale(1.05);
    zoom.pan({ x: 3, y: -2 });
    zoom.scale(1.1 / 1.05);

    expect(readScale(svg)).toBeCloseTo(1.1);
    expect(zoom.panX).toBe(3);
    expect(zoom.panY).toBe(-2);
  });

  it("clamps boundaries and ignores malformed or exhausted deltas", () => {
    const { svg, zoom } = createZoom();
    zoom.scale(10);
    expect(readScale(svg)).toBe(4);
    const maximumTransform = svg.style.transform;

    zoom.scale(2);
    zoom.scale(Number.NaN);
    zoom.pan({ x: Number.POSITIVE_INFINITY, y: 0 });
    expect(svg.style.transform).toBe(maximumTransform);

    zoom.scale(0.01);
    expect(readScale(svg)).toBe(0.5);
  });

  it("leaves native wheel events and invalid deltas untouched", () => {
    const { svg, zoom } = createZoom();
    const native = new WheelEvent("wheel", { cancelable: true, deltaY: -12 });
    const malformed = wheel(Number.NaN);

    zoom.wheel(native);
    zoom.wheel(malformed);

    expect(native.defaultPrevented).toBe(false);
    expect(malformed.defaultPrevented).toBe(false);
    expect(svg.style.transform).toBe("");
  });
});
