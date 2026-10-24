import { describe, expect, it, vi } from "vitest";
import {
  pressureBoundaryParameter,
  type PressureBoundarySegment,
} from "../../../src/domain/geometry/pressure/pressure-boundary-intersections";
import {
  MAX_PRESSURE_BOUNDARY_SCALAR_ENTRIES,
  PressureBoundaryScalarCache,
} from "../../../src/domain/geometry/pressure/pressure-boundary-scalars";
import type { PressureBoundaryArc } from "../../../src/domain/geometry/pressure/pressure-joins";
import { visitPreparedPressureOutline } from "../../../src/domain/geometry/pressure/pressure-outline";
import { iteratePressureUnion } from "../../../src/domain/geometry/pressure/pressure-union";
import { simplifyStrokeCenters } from "../../../src/domain/geometry/stroke-simplification";
import { smoothStrokeCenters } from "../../../src/domain/geometry/stroke-path";
import { finishGeometrySteps } from "../../fixtures/domain/geometry-steps";
import { createAdversarialPressureWindow } from "../../fixtures/domain/adversarial-pressure-window";

function longWaveWindow() {
  const samples: number[] = [];
  const round = (value: number) => Number(value.toFixed(2));
  for (let index = 0; index < 16_384; index += 1) {
    const sweep = Math.floor(index / 256);
    const local = (index % 256) / 255;
    samples.push(
      round(600 + (sweep % 2 ? 1 - local : local) * 13),
      round(297 + (sweep * 6) / 63 + Math.sin(local * Math.PI * 4) * 0.65),
      round(0.2 + 0.75 * (0.5 + Math.sin(index * 0.13) * 0.5)),
    );
  }
  const centers = simplifyStrokeCenters(smoothStrokeCenters(samples), 2, true);
  const shapes: Parameters<typeof iteratePressureUnion>[0][number][] = [];
  visitPreparedPressureOutline(centers, 2, (piece) => {
    shapes.push(piece.kind === "dot" ? piece : piece.capsule);
    return shapes.length === 64;
  });
  return shapes;
}

function denseDisks(tangent = false) {
  return Array.from({ length: 64 }, (_, index) => ({
    kind: "dot" as const,
    center: tangent ? { x: index * 2, y: 0 } : { x: index % 8, y: Math.floor(index / 8) },
    radius: tangent ? 1 : 3,
  }));
}

function observeScalarEntries() {
  const maps = new Set<Map<unknown, unknown>>();
  let entries = 0;
  let parameterChecks = 0;
  let peak = 0;
  const descriptor = Object.getOwnPropertyDescriptor(Map.prototype, "set")!;
  const originalSet = descriptor.value as Map<unknown, unknown>["set"];
  const publication = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
    const result = Reflect.apply(originalSet, this, [key, value]);
    if (typeof value === "object" && value !== null && "endpointScale" in value) {
      const scaleDescriptor = Object.getOwnPropertyDescriptor(value, "endpointScale");
      const endpointScale: unknown = scaleDescriptor?.value;
      if (scaleDescriptor?.configurable !== true || typeof endpointScale !== "number")
        throw new Error("Cannot observe pressure endpoint scale");
      Object.defineProperty(value, "endpointScale", {
        configurable: scaleDescriptor.configurable,
        enumerable: scaleDescriptor.enumerable ?? false,
        get: () => {
          parameterChecks += 1;
          return endpointScale;
        },
      });
      maps.add(this);
      entries += 1;
      peak = Math.max(peak, this.size);
    }
    return result;
  };
  Object.defineProperty(Map.prototype, "set", { ...descriptor, value: publication });
  return {
    maps,
    get entries() {
      return entries;
    },
    get parameterChecks() {
      return parameterChecks;
    },
    get peak() {
      return peak;
    },
    restore: () => Object.defineProperty(Map.prototype, "set", descriptor),
  };
}

function measureUnion(shapes: Parameters<typeof iteratePressureUnion>[0], uncached: boolean) {
  const reads = vi.spyOn(PressureBoundaryScalarCache.prototype, "read");
  if (uncached) reads.mockReturnValue(undefined);
  const absolute = vi.spyOn(Math, "abs");
  const signs = vi.spyOn(Math, "sign");
  const distances = vi.spyOn(Math, "hypot");
  const angles = vi.spyOn(Math, "atan2");
  try {
    const result = finishGeometrySteps(iteratePressureUnion(shapes));
    return {
      result,
      scalarReads: reads.mock.calls.length,
      absolute: absolute.mock.calls.length,
      signs: signs.mock.calls.length,
      distances: distances.mock.calls.length,
      angles: angles.mock.calls.length,
    };
  } finally {
    reads.mockRestore();
    absolute.mockRestore();
    signs.mockRestore();
    distances.mockRestore();
    angles.mockRestore();
  }
}

describe("exact pressure boundary query work", () => {
  it("reads fixed endpoints and sweep once while preserving real arc query work", () => {
    let endpointReads = 0;
    let sweepReads = 0;
    const endpoint = (x: number) => ({
      get x() {
        endpointReads += 1;
        return x;
      },
      get y() {
        endpointReads += 1;
        return 2_000;
      },
    });
    const boundary: PressureBoundaryArc = {
      kind: "arc",
      center: { x: 1_000, y: 2_000 },
      start: endpoint(1_004),
      end: endpoint(996),
      radius: 4,
      get sweep() {
        sweepReads += 1;
        return -Math.PI;
      },
    };
    const queries = Array.from({ length: 256 }, (_, index) => {
      const angle = (-Math.PI * (index + 1)) / 257;
      return { x: 1_000 + Math.cos(angle) * 4, y: 2_000 + Math.sin(angle) * 4 };
    });
    const scalars = new PressureBoundaryScalarCache(1);
    const angles = new WeakMap<PressureBoundaryArc, number>();
    const absolute = vi.spyOn(Math, "abs");
    const signs = vi.spyOn(Math, "sign");
    let fractions: (number | undefined)[];
    let absoluteCalls: number;
    let signCalls: number;
    try {
      fractions = queries.map((point) =>
        pressureBoundaryParameter(boundary, point, angles, scalars),
      );
      absoluteCalls = absolute.mock.calls.length;
      signCalls = signs.mock.calls.length;
    } finally {
      absolute.mockRestore();
      signs.mockRestore();
    }
    expect(fractions.every((fraction) => fraction !== undefined)).toBe(true);
    // Four endpoint coordinates are prepared once; each query still performs its
    // two exact endpoint checks, and initial-angle preparation reads two coordinates.
    expect(endpointReads).toBe(queries.length * 4 + 6);
    expect(sweepReads).toBe(queries.length + 1);
    expect(signCalls).toBe(1);
    // Per query: two variable scale operands, two endpoint dx checks, two radial
    // coordinate operands and one exact hypot rejection; preparation adds five abs.
    expect(absoluteCalls).toBeLessThanOrEqual(queries.length * 7 + 5);
  });
});

describe("window-owned pressure boundary scalar work", () => {
  it.each([
    { name: "maximum-stroke wave window", create: longWaveWindow, fallback: false },
    { name: "dense disks", create: () => denseDisks(), fallback: false },
    { name: "tangent disks", create: () => denseDisks(true), fallback: false },
    { name: "adversarial fallback", create: createAdversarialPressureWindow, fallback: true },
  ])("bounds exact scalar reuse and release in $name", ({ create, fallback }) => {
    const shapes = create();
    expect(shapes).toHaveLength(64);
    const direct = measureUnion(shapes, true);
    const ownership = observeScalarEntries();
    try {
      const cached = measureUnion(shapes, false);
      expect(cached.result).toEqual(direct.result);
      expect(cached.result.usedFallback).toBe(fallback);
      expect(cached.scalarReads).toBe(direct.scalarReads);
      expect(cached.scalarReads).toBeGreaterThan(0);
      expect(cached.scalarReads).toBeLessThanOrEqual(
        2 * cached.result.work.intersectionTests + cached.result.work.boundaryTests,
      );
      expect(cached.distances).toBe(direct.distances);
      expect(cached.angles).toBe(direct.angles);
      // The published endpoint-scale getter observes every real cached parameter
      // check, including checks that share one pair read; preparation adds <=5 abs/entry.
      expect(ownership.parameterChecks).toBeGreaterThan(cached.scalarReads);
      expect(cached.absolute).toBeLessThanOrEqual(
        direct.absolute - 6 * ownership.parameterChecks + 5 * ownership.entries,
      );
      expect(cached.signs).toBeLessThanOrEqual(direct.signs + ownership.entries);
      expect(ownership.maps.size).toBe(1);
      expect(ownership.peak).toBeLessThanOrEqual(MAX_PRESSURE_BOUNDARY_SCALAR_ENTRIES);
      for (const map of ownership.maps) expect(map.size).toBe(0);
    } finally {
      ownership.restore();
    }
  });
});

describe("pressure boundary scalar resource ownership", () => {
  it("releases scalar entries and stops all preparation when a suspended union is cancelled", () => {
    const ownership = observeScalarEntries();
    const reads = vi.spyOn(PressureBoundaryScalarCache.prototype, "read");
    try {
      const job = iteratePressureUnion(denseDisks());
      expect(job.next().done).toBe(false);
      const completed = reads.mock.calls.length;
      expect(completed).toBeGreaterThan(0);
      expect([...ownership.maps].some((map) => map.size > 0)).toBe(true);
      job.return(undefined as never);
      expect(job.next()).toEqual({ done: true, value: undefined });
      expect(reads).toHaveBeenCalledTimes(completed);
      for (const map of ownership.maps) expect(map.size).toBe(0);
    } finally {
      reads.mockRestore();
      ownership.restore();
    }
  });

  it("releases published scalars and stops real geometry work after preparation fails", () => {
    const ownership = observeScalarEntries();
    const descriptor = Object.getOwnPropertyDescriptor(
      PressureBoundaryScalarCache.prototype,
      "read",
    )!;
    const originalRead = descriptor.value as PressureBoundaryScalarCache["read"];
    const reads = vi.spyOn(PressureBoundaryScalarCache.prototype, "read");
    const distances = vi.spyOn(Math, "hypot");
    const failure = new Error("Failed scalar preparation");
    reads.mockImplementation(function (this: PressureBoundaryScalarCache, boundary) {
      if (reads.mock.calls.length === 20) throw failure;
      return Reflect.apply(originalRead, this, [boundary]);
    });
    try {
      const job = iteratePressureUnion(denseDisks());
      expect(() => job.next()).toThrow(failure);
      expect(ownership.entries).toBeGreaterThan(0);
      for (const map of ownership.maps) expect(map.size).toBe(0);
      const completedDistances = distances.mock.calls.length;
      expect(job.next()).toEqual({ done: true, value: undefined });
      expect(reads).toHaveBeenCalledTimes(20);
      expect(distances).toHaveBeenCalledTimes(completedDistances);
    } finally {
      reads.mockRestore();
      distances.mockRestore();
      ownership.restore();
    }
  });

  it("retains at most 256 entries and performs no endpoint reads for excess identities", () => {
    const cache = new PressureBoundaryScalarCache(MAX_PRESSURE_BOUNDARY_SCALAR_ENTRIES);
    const ownership = observeScalarEntries();
    try {
      for (let index = 0; index < MAX_PRESSURE_BOUNDARY_SCALAR_ENTRIES; index += 1)
        cache.read({ kind: "line", start: { x: index, y: 0 }, end: { x: index + 1, y: 0 } });
      let reads = 0;
      const excess: PressureBoundarySegment = {
        kind: "line",
        start: {
          get x() {
            reads += 1;
            return 0;
          },
          y: 0,
        },
        end: { x: 1, y: 0 },
      };
      expect(cache.read(excess)).toBeUndefined();
      expect(reads).toBe(0);
      expect(ownership.peak).toBe(MAX_PRESSURE_BOUNDARY_SCALAR_ENTRIES);
      cache.clear();
      for (const map of ownership.maps) expect(map.size).toBe(0);
    } finally {
      ownership.restore();
    }
  });
});

it("reuses bounded clipping cuts without allocating entry iterators", () => {
  const shapes = denseDisks();
  const arrays = new Set<readonly unknown[]>();
  const originalSort = Array.prototype.sort;
  let sorts = 0;
  let maximumCuts = 0;
  const sort = vi.spyOn(Array.prototype, "sort").mockImplementation(function (
    this: unknown[],
    compare,
  ) {
    if (this[0] === 0 && this[1] === 1) {
      sorts += 1;
      maximumCuts = Math.max(maximumCuts, this.length);
      arrays.add(this);
    }
    return Reflect.apply(originalSort, this, [compare]) as unknown[];
  });
  const entries = vi.spyOn(Array.prototype, "entries");
  let entryCalls = 0;
  let intersections = 0;
  try {
    intersections = finishGeometrySteps(iteratePressureUnion(shapes)).work.intersectionTests;
    entryCalls = entries.mock.calls.length;
  } finally {
    sort.mockRestore();
    entries.mockRestore();
  }
  // Two directed half-circle boundaries per disk own one cut buffer each.
  expect(sorts).toBeGreaterThan(shapes.length * 2);
  expect(arrays.size).toBeLessThanOrEqual(shapes.length * 2);
  expect(maximumCuts).toBeLessThanOrEqual(26);
  expect(intersections).toBeGreaterThan(0);
  expect(entryCalls).toBe(0);
});
