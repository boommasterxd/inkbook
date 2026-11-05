import { describe, expect, it } from "vitest";
import { rotatePointClockwise } from "../../../../src/domain/geometry/primitives";
import { recognizePointPath } from "./recognition-fixtures";
import {
  BROAD_ROUNDED_LOOP,
  ROUGH_RECTANGLES,
  roughRectanglePath,
} from "./rough-rectangle-fixtures";

describe("rough rectangle recognition", () => {
  it.each([80, 160, 240])(
    "retains a closed square with a short corner lead-in or overshoot at size %s",
    (size) => {
      const square = roughRectanglePath([
        [0, 0],
        [size, 0],
        [size, size],
        [0, size],
        [0, 0],
      ]);
      const tail = { x: -size / 10, y: -size / 10 };
      for (const points of [
        [tail, ...square],
        [...square, tail],
      ]) {
        expect(["rectangle", "diamond"]).toContain(recognizePointPath(points)?.kind);
        expect(["rectangle", "diamond"]).toContain(recognizePointPath([...points].reverse())?.kind);
      }
    },
  );
  it.each(ROUGH_RECTANGLES.map((vertices) => ({ vertices })))(
    "recognizes hand-rounded sides and an imperfect closing seam",
    ({ vertices }) => {
      for (const rotation of [0, 27]) {
        const points = roughRectanglePath(vertices).map((point) =>
          rotatePointClockwise(point, { x: 80, y: 55 }, rotation),
        );
        expect(recognizePointPath(points)?.kind).toBe("rectangle");
        expect(recognizePointPath([...points].reverse())?.kind).toBe("rectangle");
      }
    },
  );

  it("keeps broadly rounded closed corners out of the decorated-shaft classes", () => {
    const result = recognizePointPath(roughRectanglePath(BROAD_ROUNDED_LOOP));
    expect(["line", "arrow"]).not.toContain(result?.kind);
  });

  it("does not fill a missing rectangle side merely because three sides fit", () => {
    expect(
      recognizePointPath(
        roughRectanglePath([
          [0, 0],
          [100, 0],
          [100, 100],
          [0, 100],
        ]),
      ),
    ).toBeNull();
  });

  it("rejects a crossed closed scribble rather than manufacturing a rectangle", () => {
    const points = roughRectanglePath([
      [0, 0],
      [170, 0],
      [10, 100],
      [180, 100],
      [50, 0],
      [100, 110],
      [0, 0],
    ]);
    expect(recognizePointPath(points)).toBeNull();
  });
});
