import { describe, expect, it, vi } from "vitest";
import * as intersections from "../../../src/domain/geometry/pressure-boundary-intersections";
import * as arcBounds from "../../../src/domain/geometry/pressure-arc-bounds";
import { pressureArcPoint } from "../../../src/domain/geometry/pressure-joins";
import { visitPreparedPressureOutline } from "../../../src/domain/geometry/pressure-outline";
import * as pressureRadius from "../../../src/domain/geometry/pressure-radius";
import * as joins from "../../../src/domain/geometry/pressure-joins";
import * as windowPreparation from "../../../src/domain/geometry/pressure-window";
import { finishGeometrySteps } from "../../fixtures/domain/geometry-steps";
import { serializePressureWindows } from "../../../src/domain/geometry/pressure-path-serialization";
import { StrokeShapeCache } from "../../../src/persistence/serialization/stroke-shape-cache";
import { PreparedPressureWindowCache } from "../../../src/domain/store/prepared-pressure-window-cache";
import { CanonicalElementPathPreparation } from "../../../src/domain/geometry/canonical-element-path-preparation";
import {
  createMultiWindowPressureStroke,
  createTestStroke,
} from "../../fixtures/persistence/worker-snapshot";
import {
  iteratePressureUnion,
  pressureShapeBoundary,
} from "../../../src/domain/geometry/pressure-union";

function denseDiskWindow() {
  return Array.from({ length: 64 }, (_, index) => ({
    kind: "dot" as const,
    center: { x: index % 8, y: Math.floor(index / 8) },
    radius: 3,
  }));
}

describe("bounded pressure preparation work", () => {
  it("bounds exact-union work and resumptions while rejecting unrelated hemispheres", () => {
    const shapes = denseDiskWindow();
    const intersectionsProbe = vi.spyOn(intersections, "intersectPressureBoundaries");
    const boundaryProbe = vi.spyOn(intersections, "pressureBoundaryParameter");
    const boundsProbe = vi.spyOn(arcBounds, "pressureArcBounds");
    try {
      const job = iteratePressureUnion(shapes);
      let resumptions = 0;
      let step;
      do {
        const previous = intersectionsProbe.mock.calls.length;
        step = job.next();
        resumptions += 1;
        // One disk boundary can probe two edges for each of the other 63 disks.
        expect(intersectionsProbe.mock.calls.length - previous).toBeLessThanOrEqual(126);
      } while (!step.done);
      expect(intersectionsProbe).toHaveBeenCalledTimes(step.value.work.intersectionTests);
      expect(boundaryProbe).toHaveBeenCalledTimes(step.value.work.boundaryTests);
      // Each immutable source hemisphere prepares one extent reused in query direction.
      expect(boundsProbe).toHaveBeenCalledTimes(128);
      // Both query and source hemispheres reject unrelated full-circle comparisons.
      expect(intersectionsProbe.mock.calls.length).toBeGreaterThan(500);
      expect(intersectionsProbe.mock.calls.length).toBeLessThanOrEqual(5_500);
      expect(boundaryProbe.mock.calls.length).toBeLessThanOrEqual(2_200);
      expect(step.value.usedFallback).toBe(false);
      // Reject redundant per-source and per-interval generator polling.
      expect(resumptions).toBeLessThanOrEqual(
        128 +
          Math.ceil(step.value.work.intervalTests / 16) +
          2 * Math.ceil(step.value.work.visibleFragments / 16) +
          step.value.contours.length +
          1,
      );
      expect(resumptions).toBeLessThanOrEqual(512);
    } finally {
      intersectionsProbe.mockRestore();
      boundaryProbe.mockRestore();
      boundsProbe.mockRestore();
    }
  });

  it("stops source-boundary probes when a suspended union is cancelled", () => {
    const shapes = denseDiskWindow();
    const probes = vi.spyOn(intersections, "intersectPressureBoundaries");
    try {
      const job = iteratePressureUnion(shapes);
      expect(job.next().done).toBe(false);
      const completed = probes.mock.calls.length;
      expect(completed).toBeGreaterThan(0);
      job.return({
        contours: [],
        usedFallback: false,
        work: {
          intersectionTests: 0,
          containmentTests: 0,
          boundaryTests: 0,
          intervalTests: 0,
          peakIntervals: 0,
          visibleFragments: 0,
        },
      });
      expect(job.next()).toEqual({ done: true, value: undefined });
      expect(probes).toHaveBeenCalledTimes(completed);
      expect(iteratePressureUnion([]).next().value).toMatchObject({ contours: [] });
    } finally {
      probes.mockRestore();
    }
  });
});

describe("immutable pressure window measurement reuse", () => {
  it("measures and freezes each retained window once across aliases and canonical cache hits", () => {
    const cache = new PreparedPressureWindowCache();
    const source = createMultiWindowPressureStroke();
    const measure = vi.spyOn(windowPreparation, "measurePressureWindow");
    const freeze = vi.spyOn(Object, "freeze");
    const windows = vi.spyOn(windowPreparation, "preparePressureWindowSteps");
    let additionReads = 0;
    const port = {
      readWindow: (index: number) => cache.read(source.id, 1, index),
      readWindowMeasurement: (index: number) => cache.readMeasurement(source.id, 1, index),
      publishWindow: (index: number, value: windowPreparation.PressureWindow) => {
        Reflect.set(
          value,
          "additions",
          value.additions.map(
            (polygon) =>
              new Proxy(polygon, {
                get: (target, key, receiver) => {
                  if (typeof key === "string" && /^\d+$/u.test(key)) additionReads += 1;
                  return Reflect.get(target, key, receiver) as unknown;
                },
              }),
          ),
        );
        return cache.publish(source.id, 1, index, value);
      },
    };
    try {
      const first = new CanonicalElementPathPreparation(source, port);
      while (!first.step()) {
        /* Finish complete canonical windows. */
      }
      const count = cache.statistics().entries;
      expect(count).toBeGreaterThan(1);
      expect(measure).toHaveBeenCalledTimes(count);
      expect(freeze.mock.calls.length).toBeGreaterThan(count);
      expect(additionReads).toBeGreaterThan(0);
      const retained = cache.readMeasurement(source.id, 1, 0)!;
      measure.mockClear();
      freeze.mockClear();
      windows.mockClear();
      additionReads = 0;
      const second = new CanonicalElementPathPreparation(source, port);
      while (!second.step()) {
        /* Consume complete immutable cache witnesses. */
      }
      expect(second.parts).toEqual(first.parts);
      expect(windows).not.toHaveBeenCalled();
      expect(measure).not.toHaveBeenCalled();
      expect(freeze).not.toHaveBeenCalled();
      expect(additionReads).toBe(0);
      expect(cache.publish("alias", 1, 0, retained.window)).toBe(retained);
      expect(measure).not.toHaveBeenCalled();
      expect(freeze).not.toHaveBeenCalled();
      expect(additionReads).toBe(0);
      second.cancel();
      expect(second.memoryUsage()).toBe(0);
      cache.release();
      expect(cache.measuredWindowCount).toBe(0);
      expect(cache.statistics().bytes).toBe(0);
      cache.publish(source.id, 2, 0, retained.window);
      expect(measure).toHaveBeenCalledOnce();
      expect(freeze.mock.calls.length).toBeGreaterThan(1);
    } finally {
      measure.mockRestore();
      freeze.mockRestore();
      windows.mockRestore();
      cache.release();
    }
  });
});

describe("pressure preparation reuse", () => {
  it.each([
    { first: 0, last: 64, stopAfterFirst: false, expectedNibs: 65, expectedPieces: 64 },
    { first: 16, last: 32, stopAfterFirst: false, expectedNibs: 17, expectedPieces: 16 },
    { first: 0, last: 64, stopAfterFirst: true, expectedNibs: 2, expectedPieces: 1 },
    { first: 32, last: 32, stopAfterFirst: false, expectedNibs: 0, expectedPieces: 0 },
  ])(
    "canonicalizes each visited center once (slice $first..$last, stop: $stopAfterFirst)",
    ({ first, last, stopAfterFirst, expectedNibs, expectedPieces }) => {
      const centers = Array.from({ length: 65 }, (_, index) => ({
        x: index * 3,
        y: Math.sin(index / 4) * 10,
        pressure: 0.25 + (index % 5) * 0.15,
      }));
      const radii = vi.spyOn(pressureRadius, "pressureRadius");
      let pieces = 0;
      try {
        const stopped = visitPreparedPressureOutline(
          centers,
          2,
          () => {
            pieces += 1;
            return stopAfterFirst;
          },
          { firstBoundary: first, lastBoundary: last },
        );
        expect(stopped).toBe(stopAfterFirst);
        expect(pieces).toBe(expectedPieces);
        expect(radii).toHaveBeenCalledTimes(expectedNibs);
      } finally {
        radii.mockRestore();
      }
    },
  );

  it("reuses an unchanged arc's start angle across repeated boundary probes", () => {
    const [boundary] = pressureShapeBoundary({
      kind: "dot",
      center: { x: 40, y: -25 },
      radius: 10,
    });
    if (boundary?.kind !== "arc") throw new Error("Expected arc boundary.");
    const points = Array.from({ length: 64 }, (_, index) =>
      pressureArcPoint(boundary, (index + 1) / 65),
    );
    const angles = vi.spyOn(Math, "atan2");
    try {
      const independent = points.map((point) =>
        intersections.pressureBoundaryParameter(boundary, point),
      );
      const independentCalls = angles.mock.calls.length;
      angles.mockClear();
      const cache = new WeakMap();
      const prepared = points.map((point) =>
        intersections.pressureBoundaryParameter(boundary, point, cache),
      );
      expect(prepared).toEqual(independent);
      expect(independentCalls).toBe(128);
      expect(angles).toHaveBeenCalledTimes(65);
    } finally {
      angles.mockRestore();
    }
  });
});

describe("path-only pressure preparation work", () => {
  it("omits actual triangle publication and triangle-only arc evaluations at window capacity", () => {
    const pieces = Array.from({ length: 64 }, (_, index) => {
      const capsule = joins.buildPressureCapsule(
        { x: index * 3, y: 0, pressure: 0.5 },
        { x: (index + 1) * 3, y: 0, pressure: 0.5 },
        2,
      );
      return capsule.kind === "dot" ? capsule : { kind: "strip" as const, capsule, width: 2 };
    });
    const endpoints = vi.spyOn(joins, "pressureArcPoint");
    const originalPush = Array.prototype.push;
    const pushDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "push")!;
    let triangles = 0;
    const seen = new WeakSet<object>();
    const publication = function (this: unknown[], ...values: unknown[]) {
      for (const value of values) {
        if (!Array.isArray(value) || value.length !== 3 || seen.has(value)) continue;
        if (
          !value.every(
            (point: unknown) =>
              typeof point === "object" && point !== null && "x" in point && "y" in point,
          )
        )
          continue;
        seen.add(value);
        triangles += 1;
      }
      return originalPush.apply(this, values);
    };
    // A Vitest spy records calls through Array.push itself; observe this boundary directly.
    Object.defineProperty(Array.prototype, "push", { ...pushDescriptor, value: publication });
    try {
      const full = finishGeometrySteps(windowPreparation.preparePressureWindowSteps(pieces));
      const fullEndpoints = endpoints.mock.calls.length;
      expect(fullEndpoints).toBeGreaterThan(0);
      expect(triangles).toBe(full.additions.length);
      expect(triangles).toBeGreaterThan(0);
      triangles = 0;
      endpoints.mockClear();
      const path = finishGeometrySteps(
        windowPreparation.preparePressureWindowSteps(pieces, "path-only"),
      );
      expect(triangles).toBe(0);
      expect(endpoints).not.toHaveBeenCalled();
      expect(path.loops).toEqual(full.loops);
      expect(serializePressureWindows([path])).toBe(serializePressureWindows([full]));
    } finally {
      Object.defineProperty(Array.prototype, "push", pushDescriptor);
      endpoints.mockRestore();
    }
  });
});

describe("worker path-only preparation resources", () => {
  it("prepares and caches worker contours without measuring unused selection windows", async () => {
    const stroke = createTestStroke();
    const samples = [...stroke.points];
    const measure = vi.spyOn(windowPreparation, "pressureWindowMemoryUsage");
    const windows = vi.spyOn(windowPreparation, "preparePressureWindowSteps");
    const cache = new StrokeShapeCache();
    const controller = new AbortController();
    const checkpoint = vi.fn(() => undefined);
    try {
      const first = await cache.prepare(stroke, { signal: controller.signal, checkpoint });
      expect(measure).not.toHaveBeenCalled();
      expect(windows).toHaveBeenCalledWith(expect.any(Array), "path-only");
      expect(checkpoint).toHaveBeenCalled();
      expect(stroke.points).toEqual(samples);
      expect(cache.instrumentation.shapeBuilds).toBe(1);
      checkpoint.mockClear();
      windows.mockClear();
      expect(await cache.prepare(stroke, { signal: controller.signal, checkpoint })).toBe(first);
      // Cached preparation still consults central admission before reading the cache.
      expect(checkpoint).toHaveBeenCalledTimes(1);
      expect(windows).not.toHaveBeenCalled();
      cache.clear();
      expect(cache.instrumentation.shapeCacheBytes).toBe(0);
    } finally {
      windows.mockRestore();
      measure.mockRestore();
    }
  });

  it("cancels suspended worker preparation before publishing or retaining partial geometry", async () => {
    const stroke = createMultiWindowPressureStroke();
    const cache = new StrokeShapeCache();
    const controller = new AbortController();
    let checks = 0;
    const context = {
      signal: controller.signal,
      checkpoint: () => {
        if (++checks === 10) controller.abort(new Error("Cancelled path preparation"));
        return undefined;
      },
    };
    await expect(cache.prepare(stroke, context)).rejects.toThrow("Cancelled path preparation");
    expect(checks).toBe(10);
    expect(cache.instrumentation).toMatchObject({
      shapeBuilds: 0,
      shapeCacheBytes: 0,
      shapeCacheElements: 0,
    });
  });
});
