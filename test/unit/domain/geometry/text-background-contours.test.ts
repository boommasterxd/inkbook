import { expect, it } from "vitest";
import { rectangleCutoutsSteps } from "../../../../src/domain/geometry/rectangle-cutouts";
import { textBackgroundContoursSteps } from "../../../../src/domain/geometry/text-background-contours";
import { partitionTextBackgroundSteps } from "../../../../src/domain/geometry/text-backgrounds";
import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";
import {
  decodeSvgPathCommands,
  polygonWinding,
  sampleSvgPathContours,
} from "../../../fixtures/domain/svg-path-fill";

function contains(path: string, x: number, y: number): boolean {
  return (
    sampleSvgPathContours(path).reduce(
      (total, contour) => total + polygonWinding(contour, { x, y }),
      0,
    ) !== 0
  );
}

it("removes every interior strip edge while retaining one outer boundary and a transparent hole", () => {
  const box = { x: 10.237, y: 20.987, width: 100.123, height: 1200.543 };
  const hole = { x: 30.237, y: 999.987, width: 40.123, height: 30.543 };
  const rectangles = finishGeometrySteps(
    rectangleCutoutsSteps(box, [hole], { maximumRectangles: 16 }),
  );
  const path = finishGeometrySteps(textBackgroundContoursSteps(box, rectangles, 10));
  const contours = sampleSvgPathContours(path);
  expect(contours).toHaveLength(2);
  expect(contains(path, 50, 1010)).toBe(false);
  expect(contains(path, 20, 999.987)).toBe(true);
  expect(contours.map((contour) => polygonWinding(contour, { x: 50, y: 1010 })).sort()).toEqual([
    -1, 1,
  ]);
  let start = [0, 0];
  for (const { command, values } of decodeSvgPathCommands(path)) {
    if (command === "L") {
      const [x, y] = values;
      const horizontal = start[1] === y;
      if (horizontal && y === hole.y)
        expect([Math.min(start[0]!, x!), Math.max(start[0]!, x!)]).toEqual([
          hole.x,
          hole.x + hole.width,
        ]);
    }
    if (command !== "Z") start = values.slice(-2);
  }
});

it("joins partial shared edges at T junctions and preserves touching and overlapping cutout unions", () => {
  const box = { x: 0, y: 0, width: 100, height: 100 };
  const cutouts = [
    { x: 20, y: 20, width: 40, height: 20 },
    { x: 40, y: 30, width: 40, height: 30 },
    { x: 20, y: 60, width: 20, height: 20 },
    { x: 0, y: 0, width: 3, height: 3 },
  ];
  const rectangles = finishGeometrySteps(
    rectangleCutoutsSteps(box, cutouts, { maximumRectangles: 64 }),
  );
  const path = finishGeometrySteps(textBackgroundContoursSteps(box, rectangles, 10));
  for (let y = 5; y < 100; y += 10) {
    for (let x = 5; x < 100; x += 10) {
      const cut = cutouts.some(
        (hole) => x > hole.x && x < hole.x + hole.width && y > hole.y && y < hole.y + hole.height,
      );
      expect(contains(path, x, y)).toBe(!cut);
    }
  }
  expect(contains(path, 0.5, 0.5)).toBe(false);
  expect(contains(path, 7, 7)).toBe(true);
});

it("retains the previous partition only for legacy comparison and keeps inline alpha unchanged", () => {
  const box = { x: 0, y: 0, width: 100, height: 100 };
  const rectangles = [{ x: 20, y: 20, width: 40, height: 20, color: null, opacity: 0 }];
  const current = finishGeometrySteps(partitionTextBackgroundSteps(box, rectangles));
  const legacy = finishGeometrySteps(
    partitionTextBackgroundSteps(box, rectangles, undefined, true, 2, false),
  );
  expect(current.basePath.match(/M/gu)).toHaveLength(2);
  expect(legacy.basePath.match(/M/gu)).toHaveLength(4);
  expect(current.paints).toEqual(legacy.paints);
  expect(contains(current.basePath, 30, 30)).toBe(false);
  expect(contains(legacy.basePath, 30, 30)).toBe(false);
});
