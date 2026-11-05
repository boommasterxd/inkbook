import { describe, expect, it } from "vitest";
import { rotatePointClockwise } from "../../../../src/domain/geometry/primitives";
import { doubleTrackedArrowPath, irregularArrowPath } from "./irregular-arrow-fixtures";
import { recognizePointPath } from "./recognition-fixtures";
import type { ArrowNodeV1 } from "../../../../src/domain/schema/types";

function expectArrowNodes(
  result: ReturnType<typeof recognizePointPath>,
  node: Exclude<ArrowNodeV1, "none">,
  reverse: boolean,
): void {
  expect(result).toMatchObject({
    kind: "arrow",
    startNode: reverse ? node : "none",
    endNode: reverse ? "none" : node,
  });
}

function expectOpenReturnTrack(
  gap: number,
  headScale: number,
  zoom: number,
  curved: boolean,
): void {
  const points = doubleTrackedArrowPath("arrow", gap, curved, headScale)
    .map((point) => rotatePointClockwise(point, { x: 200, y: 0 }, curved ? 37 : -23))
    .map((point) => ({ x: point.x / zoom, y: point.y / zoom }));
  for (const reverse of [false, true]) {
    const result = recognizePointPath(reverse ? [...points].reverse() : points, zoom);
    expectArrowNodes(result, "arrow", reverse);
    expect(result && "bend" in result ? result.bend === null : undefined).toBe(!curved);
  }
}

describe("irregular arrow contours and shaft waves", () => {
  it.each(["arrow", "triangle", "diamond", "circle"] as const)(
    "fits uneven %s markers with a visibly wavy shaft",
    (node) => {
      for (const curved of [false, true]) {
        for (const [start, end] of [
          ["none", node],
          [node, "none"],
          [node, node],
        ] as const) {
          const path = irregularArrowPath(start, end, curved).map((point) =>
            rotatePointClockwise(point, { x: 200, y: 0 }, curved ? 31 : -17),
          );
          expect(recognizePointPath(path), `${start}/${end} curved=${curved}`).toMatchObject({
            kind: "arrow",
            startNode: start,
            endNode: end,
          });
        }
      }
    },
  );

  it("does not turn an incomplete asymmetric wing into a full head", () => {
    const path = irregularArrowPath("none", "arrow");
    expect(recognizePointPath(path.slice(0, -15))?.kind).not.toBe("arrow");
  });

  it.each(["triangle", "diamond"] as const)(
    "keeps %s identity rather than accepting a degenerate competing polygon",
    (node) => {
      const result = recognizePointPath(irregularArrowPath("none", node));
      expect(result).toMatchObject({ kind: "arrow", endNode: node });
    },
  );
});

describe("continuous marker contours with separated return tracks", () => {
  it.each([
    [0.5, 0.75],
    [1.5, 1],
    [3, 1.5],
  ] as const)(
    "preserves unequal open wings with a %s CSS-pixel return gap at zoom %s",
    (gap, zoom) => {
      for (const curved of [false, true]) expectOpenReturnTrack(gap, 1, zoom, curved);
    },
  );

  it.each(["triangle", "diamond", "circle"] as const)(
    "preserves a closed %s contour after a three-pixel separated return",
    (node) => {
      const points = doubleTrackedArrowPath(node, 3, true).map((point) =>
        rotatePointClockwise(point, { x: 200, y: 0 }, 53),
      );
      for (const reverse of [false, true])
        expectArrowNodes(
          recognizePointPath(reverse ? [...points].reverse() : points),
          node,
          reverse,
        );
    },
  );
});

describe("return-track separation relative to marker size", () => {
  it.each([
    [4, 1, 0.5, false],
    [6, 2, 1, true],
    [10, 2.5, 2, false],
    [14, 4, 0.5, true],
  ] as const)(
    "accepts a %s CSS-pixel gap with head scale %s at zoom %s, curved=%s",
    (gap, headScale, zoom, curved) => {
      expectOpenReturnTrack(gap, headScale, zoom, curved);
    },
  );

  it.each(["triangle", "diamond", "circle"] as const)(
    "preserves a large closed %s marker with a fourteen-pixel separated return",
    (node) => {
      const zoom = 2;
      const points = doubleTrackedArrowPath(node, 14, true, 4)
        .map((point) => rotatePointClockwise(point, { x: 200, y: 0 }, -57))
        .map((point) => ({ x: point.x / zoom, y: point.y / zoom }));
      for (const reverse of [false, true])
        expectArrowNodes(
          recognizePointPath(reverse ? [...points].reverse() : points, zoom),
          node,
          reverse,
        );
    },
  );

  it("does not give a small marker the same fourteen-pixel uncertainty as a large marker", () => {
    const points = doubleTrackedArrowPath("arrow", 14, false, 0.5);
    for (const path of [points, [...points].reverse()])
      expect(recognizePointPath(path)?.kind).not.toBe("arrow");
  });
});
