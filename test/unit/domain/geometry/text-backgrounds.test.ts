import { expect, it } from "vitest";
import {
  textBackgroundGeometrySteps,
  partitionTextBackgroundSteps,
} from "../../../../src/domain/geometry/text-backgrounds";
import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";
import { textElement } from "../../../fixtures/rendering/text";
import { polygonWinding, sampleSvgPathContours } from "../../../fixtures/domain/svg-path-fill";

function covers(path: string, x: number, y: number): boolean {
  return (
    sampleSvgPathContours(path).reduce(
      (winding, contour) => winding + polygonWinding(contour, { x, y }),
      0,
    ) !== 0
  );
}

it("cuts a selected background out of the box instead of compositing its alpha twice", () => {
  const element = textElement();
  element.ranges = [
    {
      start: 0,
      end: 5,
      style: { backgroundColor: { type: "rgba", value: "#AA3300FF" }, backgroundOpacity: 0.2 },
    },
  ];
  element.layout.lines[0]!.runs[0]!.style = element.ranges[0]!.style;
  element.layout.math = [
    {
      start: 0,
      end: 5,
      display: false,
      x: 20,
      y: 25,
      width: 10,
      height: 10,
      paths: [{ d: "M0 0L1 1" }],
    },
  ];
  const result = finishGeometrySteps(textBackgroundGeometrySteps(element));
  expect(result.paints).toHaveLength(1);
  expect(result.paints[0]).toMatchObject({
    color: { type: "rgba", value: "#AA3300FF" },
    opacity: 0.2,
  });
  expect(covers(result.basePath!, 35, 50)).toBe(false);
  expect(covers(result.basePath!, 15, 90)).toBe(true);
  expect(covers(result.paints[0]!.d, 35, 50)).toBe(true);
});

it("retains a transparent inline override and independently inherits color for opacity-only changes", () => {
  const element = textElement();
  element.layout.lines[0]!.runs[0]!.style = { backgroundColor: null };
  const transparent = finishGeometrySteps(textBackgroundGeometrySteps(element));
  expect(transparent.paints).toEqual([]);
  expect(covers(transparent.basePath!, 40, 35)).toBe(false);
  element.layout.lines[0]!.runs[0]!.style = { backgroundOpacity: 0.1 };
  const faint = finishGeometrySteps(textBackgroundGeometrySteps(element));
  expect(faint.paints).toMatchObject([{ color: element.backgroundColor, opacity: 0.1 }]);
  element.layout.lines[0]!.runs[0]!.style = {};
  expect(finishGeometrySteps(textBackgroundGeometrySteps(element))).toEqual({
    basePath: undefined,
    paints: [],
  });
});

it("shares exact cutout geometry with source editing even when measured ranges overlap", () => {
  const result = finishGeometrySteps(
    partitionTextBackgroundSteps({ x: 0, y: 0, width: 100, height: 100 }, [
      { x: -5, y: 10, width: 35, height: 30, color: null, opacity: 0 },
      { x: 20, y: 20, width: 30, height: 30, color: { type: "theme-text" }, opacity: 0.3 },
    ]),
  );
  expect(covers(result.basePath, 25, 25)).toBe(false);
  expect(covers(result.basePath, 45, 45)).toBe(false);
  expect(covers(result.basePath, 75, 25)).toBe(true);
  expect(result.paints).toHaveLength(1);
  expect(result.paints[0]!.opacity).toBe(0.3);
});

it("keeps corner holes transparent where overlapping overrides meet the rounded outside contour", () => {
  const color = { type: "theme-text" } as const;
  const result = finishGeometrySteps(
    partitionTextBackgroundSteps({ x: 0, y: 0, width: 100, height: 100 }, [
      { x: 0, y: 0, width: 1, height: 1, color, opacity: 0.2 },
      { x: 0.5, y: 0.5, width: 1, height: 1, color, opacity: 0.2 },
    ]),
  );
  expect(covers(result.basePath, 0.8, 0.8)).toBe(false);
  expect(covers(result.basePath, 1.8, 1.8)).toBe(true);
  expect(covers(result.basePath, 0.1, 0.1)).toBe(false);
  expect(covers(result.paints[0]!.d, 0.8, 0.8)).toBe(true);
  expect(covers(result.paints[0]!.d, 0.1, 0.1)).toBe(false);
  expect(result.paints).toHaveLength(1);
});

it("retains color-group order and one nonzero paint per color and alpha across overlapping fragments", () => {
  const first = { type: "rgba", value: "#FFFF00FF" } as const;
  const second = { type: "rgba", value: "#0000FFFF" } as const;
  const result = finishGeometrySteps(
    partitionTextBackgroundSteps(
      { x: 0, y: 0, width: 100, height: 100 },
      [first, second, first].map((color, index) => ({
        x: 10 + index * 5,
        y: 10,
        width: 40,
        height: 30,
        color,
        opacity: 0.2,
      })),
    ),
  );
  expect(result.paints.map(({ color, opacity }) => ({ color, opacity }))).toEqual([
    { color: first, opacity: 0.2 },
    { color: second, opacity: 0.2 },
  ]);
  expect(result.paints[0]!.d.match(/M/gu)).toHaveLength(2);
  expect(result.paints[1]!.d.match(/M/gu)).toHaveLength(1);
  expect(covers(result.basePath, 25, 25)).toBe(false);
});
