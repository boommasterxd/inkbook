import { iteratePressureBoundarySimplification } from "../../../src/domain/geometry/pressure-boundary-simplification";
import { iteratePressureContourQuantization } from "../../../src/domain/geometry/pressure-contour-quantization";
import * as primitives from "../../../src/domain/geometry/primitives";
import * as intersections from "../../../src/domain/geometry/pressure-boundary-intersections";
import { buildPressureCapsule } from "../../../src/domain/geometry/pressure-joins";
import {
  measurePressureWindow,
  preparePressureWindows,
} from "../../../src/domain/geometry/pressure-window";
import { serializePressureWindows } from "../../../src/domain/geometry/pressure-path-serialization";
import {
  iteratePressureUnion,
  pressureShapeBoundary,
  PRESSURE_UNION_OPERATIONS_PER_SHAPE,
  PRESSURE_PREPARATION_CHECK_INTERVAL as CHECK_INTERVAL,
} from "../../../src/domain/geometry/pressure-union";
import { polygonWinding, sampleSvgPathContours } from "../../fixtures/domain/svg-path-fill";
import { PRESSURE_REFERENCE } from "../../fixtures/domain/pressure-reference";
import { smoothStrokeCenters } from "../../../src/domain/geometry/stroke-path";
import { simplifyStrokeCenters } from "../../../src/domain/geometry/stroke-simplification";
import { MAX_STROKE_POINTS } from "../../../src/domain/schema/public";
import { describe, expect, it, vi } from "vitest";
import { buildPressureOutline } from "../../../src/domain/geometry/pressure-outline";
import { LiveStrokeBuilder, type LiveStrokeChunk } from "../../../src/editor/tools/live-stroke";
import { buildPressureResizeFrame } from "./geometry-frame-fixture";
const STYLE = {
  color: { type: "theme-text" as const },
  opacity: 1,
  pressureEnabled: true,
  smoothing: 0.5 as const,
  width: 22 as const,
};
function sample(index: number) {
  return { x: index % 2 ? 200 : 0, y: index, pressure: index % 2, time: index };
}
function regularCapsules(count: number, xOffset: number) {
  const centers = Array.from({ length: count }, (_, index) => ({
    x: index * 3 + xOffset,
    y: Math.sin(index / 4) * 10,
    pressure: 0.5,
  }));
  return centers.slice(1).map((last, index) => buildPressureCapsule(centers[index]!, last, 2));
}

describe("bounded canonical pressure geometry", () => {
  it("measures both pressure-window byte budgets in one point-identity pass", () => {
    const pieces = regularCapsules(65, 0).map((capsule) =>
      capsule.kind === "dot" ? capsule : { kind: "strip" as const, capsule, width: 2 },
    );
    const [window] = preparePressureWindows(pieces);
    const boundaries = window!.loops.flat();
    const visits = boundaries.reduce(
      (count, boundary) => count + (boundary.kind === "arc" ? 3 : 2),
      0,
    );
    let reads = 0;
    const observed = {
      ...window!,
      loops: window!.loops.map((loop) =>
        loop.map(
          (boundary) =>
            new Proxy(boundary, {
              get(target, key, receiver) {
                if (key === "start" || key === "end" || key === "center") reads += 1;
                return Reflect.get(target, key, receiver) as unknown;
              },
            }),
        ),
      ),
    };
    const measured = measurePressureWindow(observed);
    expect(measured.numericBytes).toBeGreaterThan(0);
    expect(measured.retainedBytes).toBeGreaterThan(measured.numericBytes);
    expect(reads).toBe(visits);
  });

  it("stitches pressure contours using bounded numeric bucket lookups", () => {
    const shapes = regularCapsules(32, -48);
    shapes.push({ kind: "dot", center: { x: 200, y: 200 }, radius: 1 });
    const lookups = vi.spyOn(Map.prototype, "get");
    let step;
    const iterator = iteratePressureUnion(shapes);
    try {
      do {
        step = iterator.next();
      } while (!step.done);
      const keys = lookups.mock.calls.map(([key]) => key as unknown);
      lookups.mockRestore();
      expect(step.value.usedFallback).toBe(false);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((key) => typeof key === "number")).toBe(true);
      expect(keys.length).toBeLessThanOrEqual(step.value.work.visibleFragments * 28);
    } finally {
      lookups.mockRestore();
    }
  });
});

describe("linear pressure-chain work", () => {
  it("prepares a single capsule without clipping or stitching", () => {
    const shape = buildPressureCapsule(
      { x: 0, y: 0, pressure: 0.2 },
      { x: 10, y: 2, pressure: 0.8 },
      4,
    );
    expect(shape.kind).toBe("capsule");
    const iterator = iteratePressureUnion([shape]);
    const step = iterator.next();
    expect(step.done).toBe(true);
    expect(step.value).toMatchObject({
      contours: [pressureShapeBoundary(shape)],
      usedFallback: false,
      work: { intersectionTests: 0, containmentTests: 0, boundaryTests: 0 },
    });
  });

  it("constructs a capacity regular chain without boundary clipping or stitching", () => {
    const shapes = regularCapsules(65, 0);
    const boundaries = vi.spyOn(intersections, "intersectPressureBoundaries");
    const parameters = vi.spyOn(intersections, "pressureBoundaryParameter");
    let reads = 0;
    const counted = new Proxy(shapes, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    try {
      const iterator = iteratePressureUnion(counted);
      let step = iterator.next();
      while (!step.done) step = iterator.next();
      expect(step.value.usedFallback).toBe(false);
      expect(step.value.contours).toHaveLength(1);
      expect(boundaries).not.toHaveBeenCalled();
      expect(parameters).not.toHaveBeenCalled();
      // Every phase makes a fixed number of passes over the 64 source capsules.
      expect(reads).toBeGreaterThan(64);
      expect(reads).toBeLessThanOrEqual(64 * 10);
      expect(step.value.contours[0]!.length).toBeLessThanOrEqual(64 * 4);
    } finally {
      boundaries.mockRestore();
      parameters.mockRestore();
    }
  });
});

describe("bounded live pressure geometry", () => {
  it("keeps maximum pressure transitions in one bounded live-tail outline", () => {
    const centers = Array.from({ length: 16 }, (_, index) => sample(index));
    const parts = buildPressureOutline(centers, 22);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.d.length).toBeGreaterThan(0);
    expect(parts[0]!.d).not.toMatch(/NaN|Infinity/);
  });

  it("preserves painted interior across canonical resize scales", () => {
    const source = Array.from({ length: 70 }, (_, index) => sample(index));
    for (const frame of [0, 136, 137, 172, 173, 599]) {
      const parts = buildPressureResizeFrame(source, frame, buildPressureOutline);
      expect(parts).toHaveLength(1);
      const contours = sampleSvgPathContours(parts[0]!.d);
      for (const index of [10, 30, 60]) {
        const point = {
          x: 123456.789 + source[index]!.x * (0.35 + (frame % 173) * 0.0137),
          y: -98765.432 + source[index]!.y * (0.61 + (frame % 137) * 0.0193),
        };
        expect(
          contours.reduce((winding, contour) => winding + polygonWinding(contour, point), 0),
        ).not.toBe(0);
      }
      expect(parts[0]!.d).not.toMatch(/NaN|Infinity/);
    }
  });

  it("keeps maximum-point live writing bounded while preserving every pressure transition", () => {
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: STYLE,
    });
    let stableChunk: LiveStrokeChunk | undefined;
    for (let index = 0; index < MAX_STROKE_POINTS; index += 8) {
      const batch = Array.from({ length: 8 }, (_, offset) => sample(index + offset));
      const preview = builder.appendBatch(batch);
      if (stableChunk !== undefined) expect(preview.finalizedChunks[0]).toBe(stableChunk);
      stableChunk ??= preview.finalizedChunks[0];
      expect(builder.instrumentation().commitBuilds).toBe(0);
    }
    const commit = builder.finish();
    expect(commit.points).toHaveLength(MAX_STROKE_POINTS * 3);
    expect(commit.geometry).toHaveLength(1);
    expect(commit.instrumentation.maximumTailSamples).toBeLessThanOrEqual(131);
    expect(commit.instrumentation.maximumFinalizedChunkSamples).toBeLessThanOrEqual(131);
    expect(commit.instrumentation).toMatchObject({
      appendedInputSamples: MAX_STROKE_POINTS,
      retainedSamples: MAX_STROKE_POINTS,
      replacedTipSamples: 0,
      commitBuilds: 1,
    });
    expect(commit.instrumentation.tailBuilds).toBe(MAX_STROKE_POINTS / 8);
    expect(commit.instrumentation.bufferGrowths).toBeLessThanOrEqual(
      Math.ceil(Math.log2(MAX_STROKE_POINTS / 16)),
    );
    expect(commit.instrumentation.finalizedChunkBuilds).toBeLessThanOrEqual(MAX_STROKE_POINTS / 8);
  });
});

describe("compact reference pressure geometry", () => {
  it("formats each relative coordinate once while serializing capsule contours", () => {
    const loops = Array.from({ length: 64 }, (_, index) =>
      pressureShapeBoundary(
        buildPressureCapsule(
          { x: 100000 + index, y: 200000, pressure: 1 },
          { x: 100030.25 + index, y: 200020.5, pressure: 1 },
          8,
        ),
      ),
    );
    const windows = [{ kind: "window" as const, additions: [], loops }];
    const format = vi.fn(String);
    vi.stubGlobal("String", format);
    let calls: number;
    let path: string;
    try {
      path = serializePressureWindows(windows);
      calls = format.mock.calls.length;
    } finally {
      vi.unstubAllGlobals();
    }
    expect(path.match(/M/g)).toHaveLength(64);
    expect(calls).toBeGreaterThan(0);
    // Each capsule scores two line starts (8), writes a move (2), one line (4),
    // and four quarter arcs (5 each). Reformatting separator operands exceeds this bound.
    expect(calls).toBeLessThanOrEqual(64 * 34);
  });

  it("bounds actual serialized geometry for the 44-stroke regression drawing", () => {
    let bytes = 0;
    let contours = 0;
    for (const stroke of PRESSURE_REFERENCE) {
      const [path] = buildPressureOutline(smoothStrokeCenters(stroke.points), stroke.width);
      bytes += path!.d.length;
      contours += (path!.d.match(/M/g) ?? []).length;
    }
    expect(PRESSURE_REFERENCE).toHaveLength(44);
    expect(bytes).toBeLessThanOrEqual(41177);
    expect(contours).toBeLessThanOrEqual(130);
  });

  it("bounds actual point reads in maximum-capacity simplification windows", () => {
    let reads = 0;
    const source = Array.from({ length: MAX_STROKE_POINTS }, (_, index) => ({
      x: index,
      y: index % 2,
      pressure: index % 2,
    }));
    const counted = new Proxy(source, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const result = simplifyStrokeCenters(counted, 22, true);
    expect(result).toHaveLength(MAX_STROKE_POINTS);
    // A 64-interval window can inspect at most the triangular sum of interior
    // points. Each inspection reads three source centers, plus retained output.
    expect(reads).toBeLessThanOrEqual(MAX_STROKE_POINTS * 97);
  });
});

describe("pressure boundary broad phase", () => {
  it("rejects off-circle arc probes inside their axis box before radial distance work", () => {
    const [arc] = pressureShapeBoundary({
      kind: "dot",
      center: { x: 0, y: 0 },
      radius: 10.37,
    });
    const distance = vi.spyOn(Math, "hypot");
    try {
      for (let x = -9; x <= 9; x += 1) {
        for (let y = -9; y <= 9; y += 1) {
          expect(intersections.pressureBoundaryParameter(arc!, { x, y })).toBeUndefined();
        }
      }
      expect(distance).not.toHaveBeenCalled();
    } finally {
      distance.mockRestore();
    }
  });

  it("rejects separated circular carriers before radial distance work at window capacity", () => {
    const distance = vi.spyOn(Math, "hypot");
    try {
      const circles = Array.from({ length: 64 }, (_, index) =>
        pressureShapeBoundary({
          kind: "dot" as const,
          center: { x: index * 15, y: index * 15 },
          radius: 10,
        }),
      );
      for (let index = 0; index < circles.length - 1; index += 1) {
        for (const first of circles[index]!) {
          for (const second of circles[index + 1]!) {
            expect(intersections.intersectPressureBoundaries(first, second)).toEqual([]);
          }
        }
      }
      const line = {
        kind: "line" as const,
        start: { x: -4, y: 2 },
        end: { x: 2, y: 8 },
      };
      const circle = pressureShapeBoundary({
        kind: "dot",
        center: { x: 1, y: 1 },
        radius: 3,
      });
      for (const arc of circle)
        expect(intersections.intersectPressureBoundaries(line, arc)).toEqual([]);
      expect(circles).toHaveLength(64);
      expect(distance).not.toHaveBeenCalled();
    } finally {
      distance.mockRestore();
    }
  });

  it("prunes separated boundary extents in dense parallel capsules", () => {
    const shapes = Array.from({ length: 64 }, (_, index) =>
      buildPressureCapsule(
        { x: 0, y: index * 0.5, pressure: 1 },
        { x: 100, y: index * 0.5, pressure: 1 },
        2,
      ),
    );
    const calls = vi.spyOn(intersections, "intersectPressureBoundaries");
    try {
      const iterator = iteratePressureUnion(shapes);
      let step = iterator.next();
      while (!step.done) step = iterator.next();
      expect(step.value.usedFallback).toBe(false);
      expect(step.value.work.intersectionTests).toBe(calls.mock.calls.length);
      expect(calls.mock.calls.length).toBeGreaterThan(0);
      // Eight adjacent capsule bounds overlap; their two remote cap pairs and
      // separated horizontal sides must not reach the exact intersection code.
      expect(calls.mock.calls.length).toBeLessThanOrEqual(64 * 8 * 8);
    } finally {
      calls.mockRestore();
    }
  });
});

describe("bounded capsule union work", () => {
  it("rejects disjoint circle extents without exact radial distance work", () => {
    const [circle] = pressureShapeBoundary({
      kind: "dot",
      center: { x: 0, y: 0 },
      radius: 1,
    });
    const distances = vi.spyOn(Math, "hypot");
    try {
      for (let index = 2; index < 66; index += 1) {
        const [other] = pressureShapeBoundary({
          kind: "dot",
          center: { x: index * 4, y: index * 4 },
          radius: 1,
        });
        expect(intersections.intersectPressureBoundaries(circle!, other!)).toEqual([]);
      }
      expect(distances).not.toHaveBeenCalled();
    } finally {
      distances.mockRestore();
    }
  });

  it("avoids endpoint distance work for interior and off-boundary probes", () => {
    const extent = MAX_STROKE_POINTS + 1;
    const boundary = { kind: "line" as const, start: { x: 0, y: 0 }, end: { x: extent, y: 0 } };
    const distances = vi.spyOn(Math, "hypot");
    try {
      for (let index = 1; index <= MAX_STROKE_POINTS; index += 1) {
        expect(intersections.pressureBoundaryParameter(boundary, { x: index, y: 0 })).toBe(
          index / extent,
        );
        expect(
          intersections.pressureBoundaryParameter(boundary, { x: index, y: 1 }),
        ).toBeUndefined();
      }
      // Each on-line projection needs one exact distance; distant endpoint and
      // off-line projection candidates require none. Repeating endpoint hypot fails this bound.
      expect(distances.mock.calls.length).toBeLessThanOrEqual(MAX_STROKE_POINTS);
    } finally {
      distances.mockRestore();
    }
  });

  it("yields between real clipping work and bounds a full adversarial window", () => {
    const shapes = Array.from({ length: 64 }, (_, index) =>
      buildPressureCapsule(
        { x: index % 2 ? 0 : 200, y: index * 0.1, pressure: index % 2 },
        { x: index % 2 ? 200 : 0, y: (index + 1) * 0.1, pressure: (index + 1) % 2 },
        22,
      ),
    );
    const calls = vi.spyOn(intersections, "intersectPressureBoundaries");
    try {
      const cancelled = iteratePressureUnion(shapes);
      cancelled.next();
      const firstReads = calls.mock.calls.length;
      expect(firstReads).toBeGreaterThan(0);
      expect(firstReads).toBeLessThanOrEqual(CHECK_INTERVAL * 4);
      cancelled.return(undefined as never);
      expect(calls.mock.calls).toHaveLength(firstReads);
      calls.mockClear();
      const pending = iteratePressureUnion(shapes);
      let step;
      do {
        const before = calls.mock.calls.length;
        step = pending.next();
        expect(calls.mock.calls.length - before).toBeLessThanOrEqual(CHECK_INTERVAL * 4);
      } while (!step.done);
      expect(step.value.work.intersectionTests).toBe(calls.mock.calls.length);
      // Four source boundaries against four boundaries of every other shape.
      expect(calls.mock.calls.length).toBeLessThanOrEqual(64 * 63 * 16);
      expect(step.value.work.peakIntervals).toBeLessThanOrEqual(1 + 8 * 63);
      const work = step.value.work;
      const operations =
        work.intersectionTests + work.intervalTests + work.boundaryTests + work.containmentTests;
      // Four pair queries, at most 24 cuts, then 25 classifications of six operations.
      expect(operations).toBeLessThanOrEqual(
        shapes.length * PRESSURE_UNION_OPERATIONS_PER_SHAPE + 4 + 25 * 6,
      );
      expect(step.value.usedFallback).toBe(true);
      expect(step.value.contours).toHaveLength(shapes.length);
      // The fallback retains each entire capsule, never a partially clipped boundary.
      expect(step.value.contours.every((contour) => contour.length === 4)).toBe(true);
    } finally {
      calls.mockRestore();
    }
  });
});

describe("incremental contour approximation work", () => {
  it.each(["simplification", "quantization"] as const)(
    "bounds real coordinate and distance work per %s step at contour capacity",
    (kind) => {
      let reads = 0;
      const points = Array.from({ length: 4095 }, (_, index) => ({
        get x() {
          reads += 1;
          return index;
        },
        get y() {
          reads += 1;
          return index % 2;
        },
      }));
      points.push(points[0]!);
      const distances = vi.spyOn(primitives, "pointSegmentDistance");
      const create = () =>
        kind === "simplification"
          ? iteratePressureBoundarySimplification(points, 0.2)
          : iteratePressureContourQuantization(points, 0.1, []);
      try {
        const cancelled = create();
        cancelled.next();
        expect(reads).toBeGreaterThan(0);
        const beforeCancellation = reads;
        cancelled.return([]);
        expect(reads).toBe(beforeCancellation);
        const iterator = create();
        let maximumReads = 0;
        let maximumDistances = 0;
        let step;
        do {
          const before = reads;
          const beforeDistances = distances.mock.calls.length;
          step = iterator.next();
          maximumReads = Math.max(maximumReads, reads - before);
          const distanceWork = distances.mock.calls.length - beforeDistances;
          maximumDistances = Math.max(maximumDistances, distanceWork);
        } while (!step.done);
        expect(step.value.length).toBeGreaterThan(0);
        expect(maximumReads).toBeGreaterThan(0);
        const group = CHECK_INTERVAL;
        // Per vertex: quantization <=16 candidates*56 reads+64 bookkeeping reads;
        // simplification <=16 chord+2 local distances*12 reads+128 local reads.
        // Phase tails add <=64 reads/vertex for quantization, or 4 for initialization.
        const readLimit =
          kind === "quantization"
            ? group * (16 * 56 + 64) + group * 64
            : group * ((group + 2) * 12 + 128) + group * 4;
        expect(maximumReads).toBeLessThanOrEqual(readLimit);
        expect(maximumDistances).toBeLessThanOrEqual(
          kind === "quantization" ? 0 : group * (group + 2),
        );
      } finally {
        distances.mockRestore();
      }
    },
  );
});
