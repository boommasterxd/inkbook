import { describe, expect, it } from "vitest";

import { recognizeStrokeSteps } from "../../../../src/domain/recognition/stroke-recognition";
import { normalizeRecognitionStrokeSteps } from "../../../../src/domain/recognition/stroke-normalization";
import { ARROW_ENDPOINT_PAIRS, arrowPath, endpointMotif } from "./arrow-fixtures";
import { observeSchemaArray } from "../../../fixtures/domain/schema-array-work";
import {
  CLOSED_VERTICES,
  aliasedZigzagSamples,
  ellipseSamples,
  quadraticSamples,
  sampledPath,
  starSamples,
  transformSamples,
} from "./recognition-fixtures";

function recognize(samples: readonly number[], zoom = 1) {
  const steps = recognizeStrokeSteps(samples, { zoom });
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

describe("single-stroke line and curve recognition", () => {
  it.each([0, 31, 87, 167, 251])("recognizes a straight line at %s degrees", (angle) => {
    const result = recognize(
      transformSamples(
        sampledPath(
          [
            [0, 0],
            [200, 0],
          ],
          false,
        ),
        angle,
      ),
    );
    expect(result).toMatchObject({ kind: "line", bend: null, startNode: "none", endNode: "none" });
  });

  it("prefers a line over fitting small input jitter as curvature", () => {
    const samples = Array.from({ length: 161 }, (_, index) => [
      index,
      Math.sin(index * 0.7) * 0.7,
      0.5,
    ]).flat();
    expect(recognize(samples)).toMatchObject({ kind: "line", bend: null });
  });

  it.each([55, 120, -110])("fits a native quadratic curve with control y=%s", (y) => {
    const result = recognize(quadraticSamples({ x: 80, y }));
    expect(result?.kind).toBe("line");
    if (result?.kind !== "line") throw new Error("Expected line geometry");
    expect(result.bend?.y).toBeCloseTo(y, -1);
    expect(result.bend?.x).toBeCloseTo(80, -1);
  });
});

describe("single-stroke closed-shape recognition", () => {
  it.each(Object.entries(CLOSED_VERTICES))(
    "fits %s across starts, directions and rotations",
    (kind, vertices) => {
      for (const angle of [0, 23, 112]) {
        for (const start of [0, 1]) {
          const shifted = [...vertices.slice(start), ...vertices.slice(0, start)];
          const result = recognize(transformSamples(sampledPath(shifted), angle, start === 1));
          expect(result?.kind, `${kind} angle=${angle} start=${start}`).toBe(kind);
        }
      }
    },
  );

  it("fits a five-point star without convexifying its inner corners", () => {
    for (const angle of [0, 27, 143]) {
      expect(recognize(transformSamples(starSamples(), angle))?.kind).toBe("star");
    }
  });

  it("retains shape classes for held-out uneven outlines and varied aspect ratios", () => {
    for (const [kind, vertices] of Object.entries(CLOSED_VERTICES)) {
      const samples = sampledPath(vertices).map((value, index) =>
        index % 3 === 2 ? 0.2 + (index % 7) / 10 : value + Math.sin(index * 1.317) * 1.4,
      );
      expect(recognize(transformSamples(samples, 38))?.kind, kind).toBe(kind);
    }
    for (const [kind, vertices] of Object.entries(CLOSED_VERTICES).filter(
      ([kind]) => kind !== "octagon",
    )) {
      const stretched = vertices.map(([x, y]) => [x! * 1.45, y! * 0.7]);
      expect(recognize(transformSamples(sampledPath(stretched), 58))?.kind, kind).toBe(kind);
    }
  });

  it.each([
    [100, 60],
    [80, 80],
    [140, 40],
  ])("fits ellipses and circles with radii %s/%s", (rx, ry) => {
    for (const angle of [17, 101]) {
      const result = recognize(transformSamples(ellipseSamples(rx, ry, 0.4), angle, true));
      expect(result?.kind).toBe("ellipse");
    }
  });
});

describe("small arrow heads and endpoint jitter", () => {
  it.each(["circle", "diamond"] as const)("retains a3px %s marking on a2000px shaft", (node) => {
    const shaft = sampledPath(
      [
        [0, 0],
        [2000, 0],
      ],
      false,
    );
    const head = endpointMotif(node)
      .slice(1)
      .flatMap((point) => [2000 + ((point.x - 120) * 3) / 20, (point.y * 3) / 20, 0.5]);
    expect(recognize([...shaft, ...head])).toMatchObject({
      kind: "arrow",
      startNode: "none",
      endNode: node,
    });
    expect(recognize(transformSamples([...shaft, ...head], 128, true))).toMatchObject({
      kind: "arrow",
      startNode: node,
      endNode: "none",
    });
  });

  it.each(["arrow", "triangle", "diamond", "circle"] as const)(
    "keeps small %s heads on long shafts",
    (node) => {
      for (const depth of [6, 10]) {
        const shaft = sampledPath(
          [
            [0, 0],
            [200, 0],
          ],
          false,
        );
        const head = endpointMotif(node)
          .slice(1)
          .flatMap((point) => [200 + ((point.x - 120) * depth) / 20, (point.y * depth) / 20, 0.5]);
        const samples = [...shaft, ...head];
        expect(recognize(samples), `end ${node} depth=${depth}`).toMatchObject({
          kind: "arrow",
          startNode: "none",
          endNode: node,
        });
        expect(
          recognize(transformSamples(samples, 73, true)),
          `start ${node} depth=${depth}`,
        ).toMatchObject({
          kind: "arrow",
          startNode: node,
          endNode: "none",
        });
      }
    },
  );

  it("keeps unstructured endpoint jitter as a line", () => {
    const shaft = sampledPath(
      [
        [0, 0],
        [200, 0],
      ],
      false,
    );
    const result = recognize([...shaft, 198, 0.4, 0.5, 200, -0.3, 0.5, 199.5, 0, 0.5]);
    expect(result).toMatchObject({ kind: "line", bend: null });
  });
});

describe("native arrow recognition", () => {
  it("keeps endpoint recognition invariant when document scale and zoom compensate", () => {
    const samples = arrowPath("circle", "diamond").flatMap((point) => [
      point.x / 10,
      point.y / 10,
      0.5,
    ]);
    expect(recognize(samples, 10)).toMatchObject({
      kind: "arrow",
      startNode: "circle",
      endNode: "diamond",
    });
  });

  it("recognizes independent arrow nodes through normalization and native shaft fitting", () => {
    for (const [start, end] of ARROW_ENDPOINT_PAIRS) {
      const samples = arrowPath(start, end).flatMap((point) => [point.x, point.y, 0.5]);
      expect(recognize(transformSamples(samples, 32)), `${start}/${end}`).toMatchObject({
        kind: "arrow",
        startNode: start,
        endNode: end,
      });
    }
  });

  it.each(["arrow", "triangle", "diamond", "circle"] as const)(
    "preserves a curved shaft with %s head",
    (node) => {
      const tangent = Math.atan2(50, 60);
      const shaft = quadraticSamples({ x: 60, y: -50 }, { x: 120, y: 0 }, 61);
      const head = endpointMotif(node)
        .slice(1)
        .flatMap((point) => {
          const dx = point.x - 120;
          return [
            120 + dx * Math.cos(tangent) - point.y * Math.sin(tangent),
            dx * Math.sin(tangent) + point.y * Math.cos(tangent),
            0.5,
          ];
        });
      const result = recognize([...shaft, ...head]);
      expect(result).toMatchObject({ kind: "arrow", endNode: node });
      if (result?.kind === "arrow") {
        expect(result.bend?.y).toBeCloseTo(-50, -1);
      }
    },
  );
});

describe("recognition rejection and resource bounds", () => {
  it.each([0, 0.07, 0.12])(
    "rejects later raw excursions hidden by resampling at phase%s",
    (phase) => {
      expect(recognize(aliasedZigzagSamples(phase))).toBeNull();
    },
  );
  it.each(
    [
      sampledPath(
        [
          [0, 0],
          [100, 0],
          [100, 100],
        ],
        false,
      ),
      sampledPath([
        [0, 0],
        [100, 100],
        [0, 100],
        [100, 0],
      ]),
      sampledPath([
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 100],
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 100],
      ]),
      Array.from({ length: 121 }, (_, index) => [
        index * 2,
        Math.sin((index / 120) * Math.PI * 2) * 45,
        0.5,
      ]).flat(),
      Array.from({ length: 121 }, (_, index) => [
        index * 2,
        Math.sin(index * 1.7) * 30,
        0.5,
      ]).flat(),
    ].map((samples) => [samples]),
  )("rejects unsupported corners, crossings, retracing and scribbles", (samples) => {
    expect(recognize(samples)).toBeNull();
  });

  it("uses screen-space minimum dimensions and rejects malformed input", () => {
    const line = sampledPath(
      [
        [0, 0],
        [20, 0],
      ],
      false,
    );
    expect(recognize(line, 0.25)).toBeNull();
    expect(recognize(line, 2)?.kind).toBe("line");
    for (const samples of [[], [1, 2], [0, 0, 0.5, NaN, 3, 0.5, 1, 1, 0.5]])
      expect(recognize(samples)).toBeNull();
    expect(recognize(line, 0)).toBeNull();
  });
});

describe("stroke normalization work", () => {
  it("preserves ordinary two-pixel input jitter without a raw-to-normalized length ratio", () => {
    const source = Array.from({ length: 241 }, (_, index) => [
      index,
      index % 2 === 0 ? 2 : -2,
      0.5,
    ]).flat();
    const steps = normalizeRecognitionStrokeSteps(source, 1);
    let step = steps.next();
    while (!step.done) step = steps.next();
    expect(step.value).not.toBeNull();
    const gentleJitter = Array.from({ length: 121 }, (_, index) => [
      index * 2,
      2 * Math.sin(index * 0.18),
      0.5,
    ]).flat();
    expect(recognize(gentleJitter)).toMatchObject({ kind: "line", bend: null });
  });
  it("retains sharp input corners during bounded normalization", () => {
    const steps = normalizeRecognitionStrokeSteps(
      sampledPath(
        [
          [0, 0],
          [123, 0],
          [123, 97],
        ],
        false,
      ),
      1,
    );
    let step = steps.next();
    while (!step.done) step = steps.next();
    expect(step.value?.points).toContainEqual({ x: 123, y: 0 });
    expect(step.value?.points.length).toBeLessThanOrEqual(256);
  });

  it("bounds input reads linearly and allows cancellation before visiting the full stroke", () => {
    const source = Array.from({ length: 30_000 }, (_, index) => (index % 3 === 0 ? index / 3 : 0));
    const { observed, work } = observeSchemaArray(source);
    const interrupted = recognizeStrokeSteps(observed, { zoom: 1 });
    interrupted.next();
    interrupted.return(null);
    expect(work.indexedReads).toBeLessThan(20);
    work.indexedReads = 0;
    expect(recognize(observed)?.kind).toBe("line");
    expect(work.indexedReads).toBeLessThanOrEqual(source.length * 2);
  });
});
