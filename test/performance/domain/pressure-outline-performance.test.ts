import { iteratePressureBoundarySimplification } from "../../../src/domain/geometry/pressure-boundary-simplification";
import { iteratePressureContourQuantization } from "../../../src/domain/geometry/pressure-contour-quantization";
import * as primitives from "../../../src/domain/geometry/primitives";
import * as intersections from "../../../src/domain/geometry/pressure-boundary-intersections";
import { buildPressureCapsule } from "../../../src/domain/geometry/pressure-joins";
import { serializePressureWindows } from "../../../src/domain/geometry/pressure-path-serialization";
import {
  iteratePressureUnion,
  pressureShapeBoundary,
  PRESSURE_UNION_OPERATIONS_PER_SHAPE,
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

describe("bounded canonical pressure geometry", () => {
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
      expect(firstReads).toBeLessThanOrEqual(4);
      cancelled.return(undefined as never);
      expect(calls.mock.calls).toHaveLength(firstReads);
      calls.mockClear();
      const pending = iteratePressureUnion(shapes);
      let step = pending.next();
      while (!step.done) step = pending.next();
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
          maximumDistances = Math.max(
            maximumDistances,
            distances.mock.calls.length - beforeDistances,
          );
        } while (!step.done);
        expect(step.value.length).toBeGreaterThan(0);
        expect(maximumReads).toBeGreaterThan(0);
        // A quantization vertex has sixteen candidates, each reading fewer than
        // 56 coordinates, plus local bookkeeping; chain distances yield individually.
        expect(maximumReads).toBeLessThanOrEqual(16 * 56 + 64);
        expect(maximumDistances).toBeLessThanOrEqual(2);
      } finally {
        distances.mockRestore();
      }
    },
  );
});
