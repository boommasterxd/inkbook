import { describe, expect, it, vi } from "vitest";
import {
  prepareTextPaintGeometrySteps,
  type TextPaintGeometry,
} from "../../../../src/domain/geometry/text-paint-geometry";
import { rotatePointClockwise } from "../../../../src/domain/geometry/primitives";
import type { PointV1, TextElementV2 } from "../../../../src/domain/schema/public";
import { createSweptCapsuleCheck } from "../../../../src/editor/gestures/eraser-intersection";
import { textElement } from "../../domain/schema/fixtures";

function prepare(element: TextElementV2): TextPaintGeometry {
  const steps = prepareTextPaintGeometrySteps(element);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

function touches(
  element: TextElementV2,
  start: PointV1,
  end = start,
  radius = 0,
  warm = false,
): boolean {
  const check = createSweptCapsuleCheck(
    start,
    end,
    radius,
    element,
    undefined,
    warm ? prepare(element) : undefined,
  );
  let progress = check.advance(1);
  while (progress.result === null) progress = check.advance(1);
  return progress.result;
}

describe("visible text eraser geometry", () => {
  it.each([false, true])(
    "hits painted runs and crossing sweeps but leaves transparent space (warm=%s)",
    (warm) => {
      const text = textElement();
      expect(touches(text, { x: 120, y: 110 }, undefined, 0, warm)).toBe(true);
      expect(touches(text, { x: 180, y: 125 }, undefined, 1, warm)).toBe(false);
      expect(touches(text, { x: 80, y: 110 }, { x: 160, y: 110 }, 0, warm)).toBe(true);
      expect(touches(text, { x: 150, y: 110 }, { x: 180, y: 110 }, 9, warm)).toBe(false);
      expect(touches(text, { x: 150, y: 110 }, { x: 180, y: 110 }, 10, warm)).toBe(true);
    },
  );

  it("includes formula paint and the table grid without erasing empty cells", () => {
    const text = textElement();
    text.layout.lines = [];
    text.layout.math = [
      {
        start: 0,
        end: 5,
        display: false,
        x: 10,
        y: 5,
        width: 20,
        height: 10,
        paths: [{ d: "M0 0L1 1" }],
      },
    ];
    text.layout.tables = [
      {
        start: 0,
        end: 5,
        x: 10,
        y: 25,
        width: 80,
        height: 20,
        columns: 2,
        rowHeights: [10, 10],
        borderWidth: 1,
      },
    ];
    expect(touches(text, { x: 120, y: 110 })).toBe(true);
    expect(touches(text, { x: 150, y: 130 })).toBe(true);
    expect(touches(text, { x: 130, y: 130 })).toBe(false);
    text.style.opacity = 0;
    expect(touches(text, { x: 120, y: 110 })).toBe(false);
    expect(touches(text, { x: 150, y: 130 })).toBe(false);
  });

  it("includes visible whole-field backgrounds and excludes transparent rounded corners", () => {
    const text = textElement();
    text.layout.lines = [];
    text.backgroundColor = { type: "theme-text" };
    text.backgroundOpacity = 0.5;
    expect(touches(text, { x: 180, y: 125 })).toBe(true);
    expect(touches(text, { x: 100, y: 100 })).toBe(false);
    expect(touches(text, { x: 99, y: 105 }, { x: 105, y: 99 }, 0)).toBe(false);
    expect(touches(text, { x: 99, y: 125 }, { x: 201, y: 125 }, 0)).toBe(true);
    text.backgroundOpacity = 0;
    expect(touches(text, { x: 180, y: 125 })).toBe(false);
  });

  it("inverse-rotates once around the field pivot for both warm and fallback checks", () => {
    const text = { ...textElement(), rotation: 90 };
    for (const warm of [false, true]) {
      const ink = rotatePointClockwise({ x: 120, y: 110 }, text.pivot, text.rotation);
      const blank = rotatePointClockwise({ x: 180, y: 125 }, text.pivot, text.rotation);
      expect(touches(text, ink, ink, 0, warm)).toBe(true);
      expect(touches(text, blank, blank, 0, warm)).toBe(false);
    }
  });
});

describe("cooperative text eraser work", () => {
  it("keeps cold preparation lazy and bounded so an abandoned sweep does no further work", () => {
    const text = textElement();
    const readText = vi.fn(() => "Hello");
    text.layout.lines = Array.from({ length: 1000 }, (_, index) => ({
      x: 0,
      y: index * 20,
      width: 40,
      height: 20,
      baseline: index * 20 + 15,
      runs: [
        {
          get text() {
            return readText();
          },
          start: 0,
          end: 5,
          x: 0,
          width: 40,
        },
      ],
    }));
    const check = createSweptCapsuleCheck({ x: 180, y: 125 }, { x: 180, y: 125 }, 0, text);
    expect(readText).not.toHaveBeenCalled();
    expect(check.advance(1)).toEqual({ result: null, workUnits: 1 });
    expect(readText).toHaveBeenCalledTimes(2);
    expect(check.advance(0)).toEqual({ result: null, workUnits: 0 });
    expect(readText).toHaveBeenCalledTimes(2);
  });

  it("queries prepared local bounds without reading the original layout", () => {
    const text = textElement();
    const geometry = prepare(text);
    const query = vi.spyOn(geometry, "querySteps");
    const lines = text.layout.lines;
    const readLayout = vi.fn(() => lines);
    Object.defineProperty(text.layout, "lines", { get: readLayout });
    const check = createSweptCapsuleCheck(
      { x: 180, y: 125 },
      { x: 180, y: 125 },
      2,
      text,
      undefined,
      geometry,
    );
    expect(check.advance(Infinity).result).toBe(false);
    expect(query).toHaveBeenCalledExactlyOnceWith({ minX: 78, minY: 23, maxX: 82, maxY: 27 });
    expect(readLayout).not.toHaveBeenCalled();
  });
});
