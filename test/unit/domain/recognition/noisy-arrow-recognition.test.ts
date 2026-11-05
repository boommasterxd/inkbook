import { describe, expect, it } from "vitest";
import { recognizeStrokeSteps } from "../../../../src/domain/recognition/stroke-recognition";
import { arrowPath, endpointMotif } from "./arrow-fixtures";
import { sampledPath, transformSamples } from "./recognition-fixtures";
import { SAVED_POINTER_ARROW_CASES } from "./saved-pointer-arrow-fixtures";

function recognize(points: readonly number[], zoom = 1) {
  const steps = recognizeStrokeSteps(points, { zoom });
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

function withJitter(points: readonly number[], phase: number): number[] {
  return points.map((value, index) =>
    index % 3 === 2 ? value : value + Math.sin(index * 1.47 + phase) * 0.45,
  );
}

describe("arrow fitting with noisy shaft endpoints", () => {
  it.each(SAVED_POINTER_ARROW_CASES)("recognizes saved native pointer samples: $id", (fixture) => {
    const result = recognize(fixture.points.flat(), fixture.zoom);
    expect(result).toMatchObject({
      kind: "arrow",
      startNode: fixture.reverse ? fixture.node : "none",
      endNode: fixture.reverse ? "none" : fixture.node,
    });
  });

  it.each(["arrow", "triangle", "diamond", "circle"] as const)(
    "recognizes %s heads across noisy starts and rotations",
    (node) => {
      const vertices = arrowPath("none", node).map((point) => [point.x, point.y]);
      const samples = sampledPath(vertices, false);
      for (const [phase, angle] of [19, 107, 247].entries()) {
        const result = recognize(
          transformSamples(withJitter(samples, phase), angle, phase % 2 === 0),
        );
        expect(result).toMatchObject({
          kind: "arrow",
          startNode: phase % 2 === 0 ? node : "none",
          endNode: phase % 2 === 0 ? "none" : node,
        });
      }
    },
  );

  it.each(["arrow", "triangle", "diamond", "circle"] as const)(
    "keeps a noisy curved shaft with %s head",
    (node) => {
      const tangent = Math.atan2(90, 135);
      const shaft = Array.from({ length: 90 }, (_, index) => {
        const t = index / 89;
        return [2 * t * (1 - t) * 105 + t ** 2 * 240, -180 * t * (1 - t), 0.5];
      }).flat();
      const headVertices = endpointMotif(node).map((point) => {
        const x = (point.x - 120) * 1.2;
        const y = point.y * 1.2;
        return [
          240 + x * Math.cos(tangent) - y * Math.sin(tangent),
          x * Math.sin(tangent) + y * Math.cos(tangent),
        ];
      });
      const result = recognize(withJitter([...shaft, ...sampledPath(headVertices, false)], 0.9));
      expect(result).toMatchObject({ kind: "arrow", endNode: node });
      if (result?.kind === "arrow") expect(result.bend?.y).toBeCloseTo(-90, -1);
    },
  );

  it("rejects asymmetric and incomplete motifs after smoothing the shaft direction", () => {
    for (const vertices of [
      [
        [0, 0],
        [200, 0],
        [180, 12],
      ],
      [
        [0, 0],
        [200, 0],
        [180, 12],
        [200, 0],
        [180, -2],
      ],
      [
        [0, 0],
        [200, 0],
        [193, 11],
        [185, -9],
        [199, 5],
      ],
    ]) {
      const result = recognize(withJitter(sampledPath(vertices, false), 1.4));
      expect(result?.kind).not.toBe("arrow");
    }
  });
});
