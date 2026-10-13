import { describe, expect, it, vi } from "vitest";
import { iteratePressureCollinearPruning } from "../../../src/domain/geometry/pressure-collinear-pruning";
import type { PointV1 } from "../../../src/domain/schema/types";
import { pressureCollinearBox } from "../../fixtures/domain/pressure-quantization-reference";

interface PruningWork {
  coordinateReads: number;
  pointWrites: number;
  indexedReads: number;
  indexedWrites: number;
  bytes: number;
  capacities: number[];
  maximumIndex: number;
}

function createWork(): PruningWork {
  return {
    coordinateReads: 0,
    pointWrites: 0,
    indexedReads: 0,
    indexedWrites: 0,
    bytes: 0,
    capacities: [],
    maximumIndex: -1,
  };
}

function observePoints(source: readonly PointV1[], work: PruningWork): PointV1[] {
  return new Proxy(
    source.map((point) => ({
      get x() {
        work.coordinateReads += 1;
        return point.x;
      },
      get y() {
        work.coordinateReads += 1;
        return point.y;
      },
    })),
    {
      set(target, key, value: unknown, receiver) {
        if (typeof key === "string" && /^\d+$/u.test(key)) work.pointWrites += 1;
        return Reflect.set(target, key, value, receiver);
      },
    },
  );
}

/** Observe actual allocations and heap/link/flag indexed operations without a runtime hook. */
function observeBuffers(work: PruningWork): void {
  const constructors = { Uint32Array, Int32Array, Uint8Array };
  for (const [name, Constructor] of Object.entries(constructors)) {
    vi.stubGlobal(
      name,
      new Proxy(Constructor, {
        construct(target, argumentsList) {
          const array = new target(argumentsList[0] as number);
          work.bytes += array.byteLength;
          work.capacities.push(array.length);
          return new Proxy(array, {
            get(buffer, key) {
              if (typeof key === "string" && /^\d+$/u.test(key)) {
                work.indexedReads += 1;
                work.maximumIndex = Math.max(work.maximumIndex, Number(key));
              }
              return Reflect.get(buffer, key, buffer) as unknown;
            },
            set(buffer, key, value: unknown) {
              if (typeof key === "string" && /^\d+$/u.test(key)) {
                work.indexedWrites += 1;
                work.maximumIndex = Math.max(work.maximumIndex, Number(key));
              }
              return Reflect.set(buffer, key, value);
            },
          });
        },
      }),
    );
  }
}

describe("bounded pressure collinear pruning work", () => {
  it.each([128, 512, 4096])(
    "bounds actual probes, heap accesses, and compaction at %s vertices",
    (count) => {
      const work = createWork();
      const points = observePoints(pressureCollinearBox(count), work);
      const slices: number[] = [];
      const indexedSlices: number[] = [];
      observeBuffers(work);
      try {
        const job = iteratePressureCollinearPruning(points);
        let step;
        do {
          const before = work.coordinateReads;
          const indexedBefore = work.indexedReads + work.indexedWrites;
          step = job.next();
          slices.push(work.coordinateReads - before);
          indexedSlices.push(work.indexedReads + work.indexedWrites - indexedBefore);
        } while (!step.done);
      } finally {
        vi.unstubAllGlobals();
      }
      // At most n + 2(n - 3) probes/additions, <=12 coordinate reads per predicate.
      const candidates = count + 2 * (count - 3);
      expect(work.coordinateReads).toBeGreaterThan(count);
      expect(work.coordinateReads).toBeLessThanOrEqual(12 * candidates);
      expect(Math.max(...slices)).toBeLessThanOrEqual(16 * 12);
      // Each queue operation crosses <=ceil(log2(n)) heap levels. This counts the real
      // comparisons/copies plus ring and deduplication reads/writes, not test advances.
      expect(work.indexedReads + work.indexedWrites).toBeLessThanOrEqual(
        candidates * (8 * Math.ceil(Math.log2(count)) + 20) + 6 * count,
      );
      expect(Math.max(...indexedSlices)).toBeLessThanOrEqual(
        16 * (8 * Math.ceil(Math.log2(count)) + 20),
      );
      expect(work.indexedReads).toBeGreaterThan(count);
      expect(work.capacities).toEqual([count, count, count, count]);
      expect(work.bytes).toBe(13 * count);
      expect(work.maximumIndex).toBeLessThan(count);
      expect(work.pointWrites).toBe(4);
      expect(points).toHaveLength(4);
      expect(points.map(({ x, y }) => ({ x, y }))).toEqual([
        { x: 0, y: 0 },
        { x: 0, y: count },
        { x: count, y: count },
        { x: count, y: 3 },
      ]);
    },
  );

  it("keeps a non-removable capacity ring linear without scratch allocation or array writes", () => {
    const work = createWork();
    const source = Array.from({ length: 4096 }, (_, index) => ({
      x: Math.cos((2 * Math.PI * index) / 4096),
      y: Math.sin((2 * Math.PI * index) / 4096),
    }));
    const points = observePoints(source, work);
    const snapshot = [...points];
    observeBuffers(work);
    try {
      const job = iteratePressureCollinearPruning(points);
      while (!job.next().done) {
        /* Consume the real coordinate probes. */
      }
    } finally {
      vi.unstubAllGlobals();
    }
    expect(work.coordinateReads).toBe(4096 * 8);
    expect(work.pointWrites).toBe(0);
    expect(work.bytes).toBe(0);
    expect(work.capacities).toEqual([]);
    points.forEach((point, index) => expect(point).toBe(snapshot[index]));
  });
});

describe("pressure collinear pruning ordering and cancellation", () => {
  it("never rescans a 2048-vertex convex prefix while removing its complete straight return edge", () => {
    const source = Array.from({ length: 4096 }, (_, index) => {
      if (index >= 2048) return { x: 0, y: -2048 + ((index - 2047) * 4096) / 2049 };
      const angle = (Math.PI * index) / 2047;
      return {
        x: index === 2047 ? 0 : Math.sin(angle) * 2048,
        y: Math.cos(angle) * 2048,
      };
    });
    const work = createWork();
    const points = observePoints(source, work);
    const prefix = points.slice(0, 2048);
    const job = iteratePressureCollinearPruning(points);
    while (!job.next().done) {
      /* Exercise the legacy quadratic restart trigger. */
    }
    expect(work.coordinateReads).toBeLessThanOrEqual(12 * (4096 + 2 * (4096 - 3)));
    expect(work.pointWrites).toBe(2048);
    expect(points).toHaveLength(2048);
    points.forEach((point, index) => expect(point).toBe(prefix[index]));
  });

  it("stops suspended heap/link work and allocates a fresh independent ring after cancellation", () => {
    const work = createWork();
    const points = observePoints(pressureCollinearBox(4096), work);
    let cancelled: PruningWork;
    const independent = pressureCollinearBox(128);
    observeBuffers(work);
    try {
      const job = iteratePressureCollinearPruning(points);
      // First removal is index 3; ring initialization itself reads no coordinates.
      while (work.coordinateReads < 16 * 12) job.next();
      job.return(undefined);
      cancelled = { ...work, capacities: [...work.capacities] };
      expect(job.next()).toEqual({ done: true, value: undefined });
      expect(work).toEqual(cancelled);
      const fresh = iteratePressureCollinearPruning(independent);
      while (!fresh.next().done) {
        /* Finish a separate job after cancellation. */
      }
    } finally {
      vi.unstubAllGlobals();
    }
    expect(cancelled.capacities).toEqual([4096, 4096, 4096, 4096]);
    expect(cancelled.bytes).toBe(13 * 4096);
    expect(points).toHaveLength(4096);
    expect(independent).toHaveLength(4);
    expect(work.capacities).toEqual([4096, 4096, 4096, 4096, 128, 128, 128, 128]);
    expect(work.bytes).toBe(13 * (4096 + 128));
  });
});
