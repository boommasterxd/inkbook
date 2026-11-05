import { describe, expect, it } from "vitest";
import { rotatePointClockwise } from "../../../../src/domain/geometry/primitives";
import { recognizeLinear } from "../../../../src/domain/recognition/linear-recognition";
import { recognizePointPath } from "./recognition-fixtures";
import { shallowArrowPath, shallowLinePath } from "./shallow-linear-fixtures";

describe("straight line preference", () => {
  it.each([0, 37, 123])("straightens a gentle noisy bow at %s degrees", (rotation) => {
    for (const length of [240, 420]) {
      const path = shallowLinePath(length * 0.05, length, 1).map((point) =>
        rotatePointClockwise(point, { x: length / 2, y: 0 }, rotation),
      );
      for (const points of [path, [...path].reverse()]) {
        expect(recognizeLinear(points)).toMatchObject({ kind: "line", bend: null });
        expect(recognizePointPath(points)).toMatchObject({ kind: "line", bend: null });
      }
    }
  });

  it.each([0.12, -0.15])("retains an intentional bow with relative sagitta %s", (ratio) => {
    const path = shallowLinePath(240 * ratio).map((point) =>
      rotatePointClockwise(point, { x: 120, y: 0 }, 57),
    );
    for (const result of [recognizeLinear(path), recognizePointPath(path)]) {
      expect(result?.kind).toBe("line");
      expect(result && "bend" in result ? result.bend : null).not.toBeNull();
    }
  });

  it("preserves the screen-space allowance for short lines across zoom levels", () => {
    const path = shallowLinePath(2.5, 40);
    for (const recognize of [recognizeLinear, recognizePointPath]) {
      expect(recognize(path, 0.5)).toMatchObject({ kind: "line", bend: null });
      const result = recognize(path, 2);
      expect(result?.kind).toBe("line");
      expect(result && "bend" in result ? result.bend : null).not.toBeNull();
    }
  });

  it("keeps a straight continuation straight after repeated endpoint hold jitter", () => {
    const path = [
      ...Array.from({ length: 61 }, (_, index) => ({ x: index * 6, y: 0 })),
      ...[
        [6, 0],
        [0, 0.4],
        [7, -0.3],
        [1, 0.3],
        [8, 0],
        [2, -0.4],
        [11, 0.2],
        [3, 0],
        [30, 0],
        [36, 0],
        [42, 0],
        [48, 0],
        [54, 0],
      ].map(([x, y]) => ({ x: 360 + x!, y: y! })),
    ];
    expect(recognizePointPath(path)).toMatchObject({ kind: "line", bend: null });
  });

  it("retains a coalesced hold-jitter excursion when the line continues afterward", () => {
    const path = [10, 210, 218, 222, 223, 210, 250].map((x) => ({ x, y: 20 }));
    expect(recognizePointPath(path)).toMatchObject({ kind: "line", bend: null });
  });
});

describe("linear gesture detail and arrowheads", () => {
  it.each([
    [210, 190, 400],
    [110, 90, 200],
    [510, 490, 1000],
  ])("keeps a collinear interior reversal raw across fitting paths: %s", (...positions) => {
    expect(recognizePointPath([0, ...positions].map((x) => ({ x, y: 0 })))).toBeNull();
  });

  it("keeps a smooth arch with a broad central indentation raw", () => {
    const points = Array.from({ length: 161 }, (_, index) => {
      const angle = (Math.PI * index) / 160;
      return {
        x: 120 * (1 - Math.cos(angle)),
        y: -120 * Math.sin(angle) - 20 * Math.sin(3 * angle),
      };
    });
    expect(recognizePointPath(points)).toBeNull();
  });

  it.each([
    [
      [0, 0],
      [95, 0],
      [100, 10],
      [105, 0],
      [200, 0],
    ],
    [
      [0, 0],
      [100, 8],
      [94, 8],
      [200, 0],
    ],
    [
      [0, 0],
      [120, 0],
      [120, 90],
    ],
    [
      [0, 0],
      [200, 0],
      [200, 140],
      [0, 140],
      [0, 15],
    ],
  ])("does not flatten corners, retracing or an unfinished outline", (...vertices) => {
    const points = vertices.map(([x, y]) => ({ x: x!, y: y! }));
    expect(recognizeLinear(points)).toBeNull();
    expect(recognizePointPath(points)?.kind).not.toBe("line");
  });

  it.each(["arrow", "triangle", "diamond", "circle"] as const)(
    "keeps both %s heads while choosing straight or curved native shafts",
    (node) => {
      for (const sagitta of [12, 36]) {
        const points = shallowArrowPath(sagitta, node, node).map((point) =>
          rotatePointClockwise(point, { x: 120, y: 0 }, 31),
        );
        const result = recognizePointPath(points);
        expect(result).toMatchObject({ kind: "arrow", startNode: node, endNode: node });
        const bend = result && "bend" in result ? result.bend : undefined;
        if (sagitta === 12) expect(bend).toBeNull();
        else expect(bend).toBeDefined();
        if (sagitta === 36) expect(bend).not.toBeNull();
      }
    },
  );
});
