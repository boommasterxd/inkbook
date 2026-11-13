import { expect, it } from "vitest";
import {
  roundedBackgroundIntersection,
  textBackgroundBoxPath,
  textBackgroundRadius,
} from "../../../../src/domain/geometry/rounded-background-path";
import { partitionTextBackgroundSteps } from "../../../../src/domain/geometry/text-backgrounds";
import {
  validatePathDataSteps,
  type PathCommand,
} from "../../../../src/persistence/documents/path-data-validator";
import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";

const box = { x: 0, y: 0, width: 100, height: 100 };

it("scales field corners with the text inset and clamps narrow or short fields", () => {
  expect(textBackgroundRadius({ ...box, width: 400 }, 24)).toBe(28);
  expect(textBackgroundRadius({ ...box, width: 400 }, 48)).toBe(48);
  expect(textBackgroundRadius(box, 24)).toBe(25);
  expect(textBackgroundRadius(box, 48)).toBe(25);
  expect(textBackgroundRadius({ ...box, width: 20 }, 48)).toBe(5);
  expect(textBackgroundRadius({ ...box, height: 10 }, 48)).toBe(5);
  const radius = textBackgroundRadius(box, 48);
  const outline = commands(textBackgroundBoxPath(box, radius));
  expect(
    outline.filter((entry) => entry.command === "A").map((arc) => arc.values.slice(0, 2)),
  ).toEqual([
    [25, 25],
    [25, 25],
    [25, 25],
    [25, 25],
  ]);
  const strip = { x: 0, y: 0, width: 24, height: 24 };
  const paint = finishGeometrySteps(
    partitionTextBackgroundSteps(
      box,
      [
        {
          ...strip,
          color: { type: "theme-text" },
          opacity: 0.5,
        },
      ],
      undefined,
      true,
      radius,
    ),
  );
  expect(paint.paints[0]!.d).toBe(roundedBackgroundIntersection(box, strip, radius));
});

function commands(path: string): { command: PathCommand; values: number[] }[] {
  const result: { command: PathCommand; values: number[] }[] = [];
  const validation = finishGeometrySteps(
    validatePathDataSteps(path, {
      observeCommand: (command, values) => result.push({ command, values: [...values] }),
    }),
  );
  expect(validation).not.toBeNull();
  return result;
}

it("keeps the default rectangle round-join radius inside the field bounds", () => {
  const rounded = commands(textBackgroundBoxPath(box));
  expect(rounded.filter((entry) => entry.command === "A")).toHaveLength(4);
  for (const arc of rounded.filter((entry) => entry.command === "A"))
    expect(arc.values.slice(0, 5)).toEqual([2, 2, 0, 0, 1]);
  expect(rounded[rounded.length - 1]!.command).toBe("Z");
  expect(roundedBackgroundIntersection(box, { x: 0, y: 10, width: 100, height: 10 })).toBe(
    "M0 10H100V20H0Z",
  );
});

it("intersects a partially covered corner with its circle instead of rounding each strip", () => {
  const clipped = commands(roundedBackgroundIntersection(box, { x: 0, y: 0, width: 1, height: 1 }));
  const arc = clipped.find((entry) => entry.command === "A")!;
  const start = clipped[0]!.values;
  const arcEnd = arc.values.slice(5);
  const circleIntersection = 2 - Math.sqrt(3);
  expect(start[0]).toBe(1);
  expect(start[1]).toBeCloseTo(circleIntersection, 3);
  expect(arcEnd).toEqual(start);
  expect(clipped.filter((entry) => entry.command === "L").map((entry) => entry.values)).toEqual([
    [1, 1],
    [0.268, 1],
  ]);
  expect(roundedBackgroundIntersection(box, { x: 0, y: 0, width: 0.2, height: 0.2 })).toBe("");
});

it("keeps overlapping corner cutouts out of the base and composites their paint once", () => {
  const color = { type: "theme-text" } as const;
  const rectangles = [
    { x: 0, y: 0, width: 1, height: 1, color, opacity: 0.2 },
    { x: 0.5, y: 0.5, width: 1, height: 1, color, opacity: 0.2 },
    { x: 99.8, y: 99.8, width: 0.2, height: 0.2, color, opacity: 0.7 },
  ];
  const result = finishGeometrySteps(partitionTextBackgroundSteps(box, rectangles));
  expect(result.paints).toHaveLength(1);
  expect(result.paints[0]!.opacity).toBe(0.2);
  const first = roundedBackgroundIntersection(box, rectangles[0]!);
  const second = roundedBackgroundIntersection(box, rectangles[1]!);
  expect(result.paints[0]!.d).toBe(first + second);
  commands(result.basePath);
  commands(result.paints[0]!.d);
  const transparent = finishGeometrySteps(
    partitionTextBackgroundSteps(
      box,
      rectangles.map((rectangle) => ({ ...rectangle, color: null })),
    ),
  );
  expect(transparent.basePath).toBe(result.basePath);
  expect(transparent.paints).toEqual([]);
});

it("retains every quarter-circle when small fields clamp adjacent corner centers together", () => {
  const circle = commands(textBackgroundBoxPath({ x: 3, y: 4, width: 2, height: 2 }));
  expect(circle.filter((entry) => entry.command === "A")).toHaveLength(4);
  expect(roundedBackgroundIntersection(box, { x: -1, y: -1, width: 1, height: 1 })).toBe("");
});
