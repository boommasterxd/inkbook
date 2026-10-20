import { FILE_SCHEMA_LIMITS, MAX_STROKE_POINTS } from "../../../src/domain/schema/public";
import { eraserQuery } from "../../fixtures/editor/eraser-query";
import { describe, expect, it, vi } from "vitest";

import type { BoxShapeElementV1 } from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import { EraserSweep } from "../../../src/editor/gestures/public";
import {
  countedEraserStroke,
  createCountedDenseStrokeEraser,
  observeIndexBuffers,
} from "./eraser-performance-fixture";
import { createSweptCapsuleCheck } from "../../../src/editor/gestures/eraser-intersection";
import {
  EraserStrokeIndex,
  EraserStrokeIndexCache,
  MAX_ERASER_INDEX_BYTES,
} from "../../../src/editor/gestures/eraser-stroke-index";
import { maximumStroke } from "./maximum-stroke-fixture";
import { rectangle as geometryRectangle } from "../../unit/domain/geometry/fixtures";

const ORIGINAL_STROKE_POINTS = 4_096;

describe("eraser hot paths", () => {
  it("bounds dense indexed discovery and element reads across stationary continuations", () => {
    const base = rectangle();
    const store = new ElementStore(
      Array.from({ length: 10_000 }, (_, index) => ({
        ...base,
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      })),
    );
    let indexWork = 0;
    let reads = 0;
    let queries = 0;
    const eraser = new EraserSweep(
      { x: 40, y: 50 },
      4,
      {
        beginQuery: (bounds) => {
          queries += 1;
          const cursor = store.beginQuery(bounds);
          return {
            cancel: () => cursor.cancel(),
            advance: (budget) => {
              expect(budget).toBeLessThanOrEqual(128);
              const progress = cursor.advance(budget);
              indexWork += progress.workUnits;
              return progress;
            },
          };
        },
        getElement: (id) => {
          reads += 1;
          return store.get(id)?.element as BoxShapeElementV1 | undefined;
        },
      },
      { setCandidateFade: () => undefined, clearCandidateFade: () => undefined },
      undefined,
      () => indexWork + reads >= 12_288,
    );
    let passes = 0;
    try {
      expect(eraser.candidateCount).toBeLessThan(store.size);
      while (true) {
        expect(indexWork + reads).toBeLessThanOrEqual(12_288 + 1_024);
        expect(eraser.retainedCandidateIdCount).toBeLessThanOrEqual(128);
        if (eraser.retainedSweepCount === 0) break;
        expect(passes++).toBeLessThan(20);
        indexWork = 0;
        reads = 0;
        expect(eraser.updateBatch([])).toBe("accepted");
      }
      expect(passes).toBeGreaterThan(0);
      expect(queries).toBe(1);
      expect(eraser.candidateCount).toBe(10_000);
      expect(store.instrumentation.fullStoreScans).toBe(0);
    } finally {
      eraser.revert();
    }
  });

  it.each([5_000, 20_000])("keeps incremental feedback linear for %i candidates", (count) => {
    const element = rectangle();
    const ids = Array.from({ length: count }, (_, index) => `shape-${index}`);
    let queryIndex = 0;
    let addedCount = 0;
    let fullSetUpdates = 0;
    const eraser = new EraserSweep(
      { x: 0, y: 50 },
      4,
      {
        getElement: () => element,
        beginQuery: () => {
          queryIndex += 1;
          const id = ids[queryIndex - 2];
          return eraserQuery(id === undefined ? [] : [id]);
        },
      },
      {
        addCandidateFade: (added) => {
          addedCount += added.length;
        },
        clearCandidateFade: () => undefined,
        setCandidateFade: () => {
          fullSetUpdates += 1;
        },
      },
    );
    for (let index = 0; index < count; index += 1)
      eraser.update({ x: index % 2 === 0 ? 100 : 0, y: 50 });

    expect(eraser.candidateCount).toBe(count);
    expect(addedCount).toBe(count);
    expect(fullSetUpdates).toBe(0);
  });
});

it("uses remaining shared budget beyond the former indexed-visit quota", () => {
  const base = rectangle();
  const store = new ElementStore(
    Array.from({ length: 15_000 }, (_, index) => ({
      ...base,
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    })),
  );
  let indexWork = 0;
  const eraser = new EraserSweep(
    { x: 40, y: 50 },
    4,
    {
      beginQuery: (bounds) => {
        const cursor = store.beginQuery(bounds);
        return {
          cancel: () => cursor.cancel(),
          advance: (budget: number) => {
            const progress = cursor.advance(budget);
            indexWork += progress.workUnits;
            return progress;
          },
        };
      },
      getElement: (id) => store.get(id)?.element as BoxShapeElementV1 | undefined,
    },
    { setCandidateFade: () => undefined, clearCandidateFade: () => undefined },
    undefined,
    () => false,
  );

  expect(indexWork).toBeGreaterThan(12_288);
  expect(eraser.candidateCount).toBe(store.size);
  expect(eraser.retainedSweepCount).toBe(0);
  expect(store.instrumentation.fullStoreScans).toBe(0);
  eraser.revert();
});

// Preserve the original density cases and exercise the new per-stroke maximum within
// the document's aggregate point capacity, rather than quadrupling that capacity.
it.each([
  [16, ORIGINAL_STROKE_POINTS],
  [128, ORIGINAL_STROKE_POINTS],
  [488, ORIGINAL_STROKE_POINTS],
  [Math.floor(FILE_SCHEMA_LIMITS.strokePoints / MAX_STROKE_POINTS), MAX_STROKE_POINTS],
])("bounds exact point visits per update for %i strokes of %i points", (count, pointCount) => {
  expect(count * pointCount).toBeLessThanOrEqual(FILE_SCHEMA_LIMITS.strokePoints);
  const fixture = createCountedDenseStrokeEraser(
    count,
    undefined,
    pointCount,
    (reads) => reads >= 12_288,
  );
  const segmentsPerStroke = pointCount - 1;
  const workPerUpdate = 12_288;
  // Each newly opened stroke reads two initial x coordinates in addition to its segments.
  const setupReads = 2 * (Math.ceil(workPerUpdate / segmentsPerStroke) + 1);
  let updates = 0;
  let totalReads = 0;
  try {
    while (fixture.eraser.candidateCount < count) {
      expect(updates).toBeLessThan(Math.ceil((count * segmentsPerStroke) / workPerUpdate) + 1);
      expect(fixture.eraser.update({ x: pointCount + 1_000, y: 0 })).toBe("accepted");
      const reads = fixture.takePointReads();
      expect(reads).toBeGreaterThan(0);
      expect(reads).toBeLessThanOrEqual(workPerUpdate + 1_024 + setupReads);
      expect(fixture.eraser.retainedCandidateIdCount).toBeLessThanOrEqual(count);
      expect(fixture.eraser.retainedSweepCount).toBeLessThanOrEqual(1);
      totalReads += reads;
      updates += 1;
      expect(fixture.eraser.retainedStrokeIndexBytes).toBeLessThanOrEqual(MAX_ERASER_INDEX_BYTES);
    }
    expect(totalReads).toBeGreaterThanOrEqual(count * segmentsPerStroke);
    // The immutable stroke width is resolved once per candidate, not once per segment.
    expect(fixture.widthReads).toBe(count);
  } finally {
    fixture.eraser.revert();
  }
  expect(fixture.eraser.retainedStrokeIndexBytes).toBe(0);
});

function rectangle(): BoxShapeElementV1 {
  return geometryRectangle({
    createdAt: 1,
    height: 20,
    id: "shape",
    pivot: { x: 50, y: 50 },
    width: 20,
    x: 40,
    y: 40,
  });
}

it("reuses section geometry for repeated near misses and near-parallel diagonal sweeps", () => {
  let reads = 0;
  const stroke = countedEraserStroke(
    maximumStroke(
      0,
      Array.from({ length: MAX_STROKE_POINTS }, (_, index) => [index, index + 5, 0.5]).flat(),
    ),
    () => {
      reads += 1;
    },
  );
  const cache = new EraserStrokeIndexCache();
  const buffers = observeIndexBuffers();
  const record = vi.spyOn(EraserStrokeIndex.prototype, "record");
  const overlaps = vi.spyOn(EraserStrokeIndex.prototype, "overlaps");
  const prepare = vi.spyOn(EraserStrokeIndex.prototype, "prepareOne");
  try {
    const scenarios = [
      [
        { x: 5_000, y: 5_000 },
        { x: 5_000, y: 5_000 },
      ],
      [
        { x: 0, y: 0 },
        { x: MAX_STROKE_POINTS - 1, y: MAX_STROKE_POINTS - 1 },
      ],
      [
        { x: MAX_STROKE_POINTS - 1, y: MAX_STROKE_POINTS - 1 },
        { x: 0, y: 0 },
      ],
    ] as const;
    const first = scenarios[0];
    for (const scan of [0, 1]) {
      reads = 0;
      expect(
        createSweptCapsuleCheck(first[0], first[1], 1, stroke, cache).advance(Infinity).result,
      ).toBe(false);
      expect(reads).toBe(MAX_STROKE_POINTS + 1);
      expect(record).toHaveBeenCalledTimes(scan * (MAX_STROKE_POINTS - 1));
      expect(cache.byteLength).toBe(scan * 57_312);
      expect(buffers.count).toBe(scan * 2);
      expect(buffers.bytes).toBe(scan * 57_312);
    }
    for (const [start, end] of scenarios) {
      reads = 0;
      overlaps.mockClear();
      prepare.mockClear();
      const check = createSweptCapsuleCheck(start, end, 1, stroke, cache);
      let progress;
      do {
        const before =
          overlaps.mock.calls.length +
          prepare.mock.results.filter(({ value }) => value === false).length;
        progress = check.advance(128);
        const actual =
          overlaps.mock.calls.length +
          prepare.mock.results.filter(({ value }) => value === false).length -
          before;
        expect(actual).toBe(progress.workUnits);
        expect(actual).toBeLessThanOrEqual(128);
      } while (progress.result === null);
      expect(progress.result).toBe(false);
      expect(reads).toBe(0);
      // Every internal parent is built once, and a sweep visits each packed node at most once.
      expect(
        prepare.mock.results.filter(({ value }) => value === false).length,
      ).toBeLessThanOrEqual(511);
      expect(overlaps.mock.calls.length).toBeLessThanOrEqual(1_023);
      expect(prepare.mock.results.filter(({ value }) => value === true)).toHaveLength(1);
    }
    reads = 0;
    overlaps.mockClear();
    const endpoint = { x: MAX_STROKE_POINTS - 1, y: MAX_STROKE_POINTS + 4 };
    expect(
      createSweptCapsuleCheck(endpoint, endpoint, 1, stroke, cache).advance(Infinity).result,
    ).toBe(true);
    expect(reads).toBeLessThanOrEqual(33);
    expect(overlaps.mock.calls.length).toBeLessThanOrEqual(19);
    expect(record).toHaveBeenCalledTimes(MAX_STROKE_POINTS - 1);
    expect(cache.byteLength).toBe(57_312);
  } finally {
    cache.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
  expect(cache.byteLength).toBe(0);
});

it.each(["commit", "cancel"] as const)(
  "releases cached stroke geometry on %s after scheduler-controlled incremental preparation",
  async (completion) => {
    let reads = 0;
    let checkpoints = 0;
    let cancelled = false;
    const prepare = vi.spyOn(EraserStrokeIndex.prototype, "prepareOne");
    const stroke = countedEraserStroke(maximumStroke(0), () => {
      reads += 1;
    });
    const eraser = new EraserSweep(
      { x: 0, y: 0 },
      1,
      { beginQuery: () => eraserQuery([stroke.id]), getElement: () => stroke },
      { setCandidateFade: () => undefined, clearCandidateFade: () => undefined },
      undefined,
      () => {
        checkpoints += 1;
        return true;
      },
    );
    expect(reads).toBeLessThanOrEqual(1_024 + 2);
    expect(eraser.retainedSweepCount).toBe(1);
    while (eraser.retainedSweepCount > 0) eraser.updateBatch([]);
    expect(checkpoints).toBeGreaterThan(1);
    expect(eraser.retainedStrokeIndexBytes).toBe(0);
    eraser.update({ x: 1, y: 0 });
    while (eraser.retainedSweepCount > 0) eraser.updateBatch([]);
    expect(eraser.retainedStrokeIndexBytes).toBeGreaterThan(0);
    expect(eraser.retainedStrokeIndexBytes).toBeLessThanOrEqual(MAX_ERASER_INDEX_BYTES);
    reads = 0;
    eraser.enqueueBatch([{ x: 2, y: 0 }]);
    expect(reads).toBe(0);
    const removals: string[] = [];
    try {
      await eraser.commit(
        (ids) => {
          removals.push(...ids);
          return true;
        },
        {
          isCancelled: () => cancelled,
          shouldYield: () => true,
          yieldControl: async () => {
            if (
              completion === "cancel" &&
              prepare.mock.results.some(({ value }) => value === false)
            ) {
              cancelled = true;
            }
          },
        },
      );
      const parentBuilds = prepare.mock.results.filter(({ value }) => value === false).length;
      expect(parentBuilds).toBeGreaterThan(0);
      if (completion === "commit") expect(parentBuilds).toBe(511);
      else expect(parentBuilds).toBeLessThanOrEqual(124);
      expect(reads).toBe(0);
    } finally {
      prepare.mockRestore();
      eraser.revert();
    }
    expect(removals).toEqual([]);
    expect(eraser.retainedStrokeIndexBytes).toBe(0);
    expect(eraser.retainedSweepCount).toBe(0);
  },
);

it("keeps a maximum-stroke first hit free of index allocation and preparation", () => {
  let reads = 0;
  const stroke = countedEraserStroke(maximumStroke(0), () => {
    reads += 1;
  });
  const cache = new EraserStrokeIndexCache();
  const buffers = observeIndexBuffers();
  const record = vi.spyOn(EraserStrokeIndex.prototype, "record");
  const remember = vi.spyOn(cache, "rememberMiss");
  try {
    const check = createSweptCapsuleCheck(
      { x: -1_000, y: 0 },
      { x: MAX_STROKE_POINTS + 1_000, y: 0 },
      1,
      stroke,
      cache,
    );
    let progress;
    do {
      progress = check.advance(128);
    } while (progress.result === null);
    expect(progress.result).toBe(true);
    expect(reads).toBeGreaterThanOrEqual(MAX_STROKE_POINTS - 1);
    expect(reads).toBeLessThanOrEqual(MAX_STROKE_POINTS + 1);
    expect(record).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
    expect(buffers.count).toBe(0);
    expect(cache.byteLength).toBe(0);
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    cache.clear();
  }
});

it("updates a recorded section from new endpoints without reading known starts again", () => {
  const index = new EraserStrokeIndex(64);
  let segment = 0;
  let startReads = 0;
  const line = {
    get startX() {
      startReads += 1;
      return segment;
    },
    get startY() {
      startReads += 1;
      return segment + 5;
    },
    get endX() {
      return segment + 1;
    },
    get endY() {
      return segment + 6;
    },
  };
  for (segment = 0; segment < 64; segment += 1) {
    startReads = 0;
    index.record(segment, line);
    expect(startReads).toBe(segment % 32 === 0 ? 10 : 0);
  }
  expect(typeof index.leafRange(1)).toBe("number");
});

it("drains multiple feedback quanta without a frame wait while the shared budget remains", async () => {
  const fixture = createCountedDenseStrokeEraser(16, undefined, MAX_STROKE_POINTS, () => true);
  const yieldControl = vi.fn(async () => undefined);
  const remove = vi.fn((ids: ReadonlySet<string>) => {
    expect(ids.size).toBe(16);
    return true;
  });
  let checkpoints = 0;
  let totalPointReads = fixture.takePointReads();
  fixture.eraser.update({ x: MAX_STROKE_POINTS + 1_000, y: 0 });
  totalPointReads += fixture.takePointReads();

  const committed = await fixture.eraser.commit(remove, {
    isCancelled: () => false,
    shouldYield: () => {
      const reads = fixture.takePointReads();
      totalPointReads += reads;
      expect(reads).toBeLessThanOrEqual(256 + 2);
      checkpoints += 1;
      return false;
    },
    yieldControl,
  });

  expect(committed).toBe(true);
  expect(remove).toHaveBeenCalledOnce();
  expect(checkpoints).toBeGreaterThan(12_288 / 256);
  expect(totalPointReads + fixture.takePointReads()).toBeGreaterThan(12_288);
  expect(yieldControl).not.toHaveBeenCalled();
  expect(fixture.eraser.retainedSweepCount).toBe(0);
});

it("cancels finalization at the next yield without reading or publishing more work", async () => {
  const fixture = createCountedDenseStrokeEraser(128, undefined, MAX_STROKE_POINTS, () => true);
  let cancelled = false;
  let removals = 0;
  let yields = 0;
  try {
    fixture.eraser.update({ x: MAX_STROKE_POINTS + 1_000, y: 0 });
    const committed = await fixture.eraser.commit(
      () => {
        removals += 1;
        return true;
      },
      {
        isCancelled: () => cancelled,
        shouldYield: () => true,
        yieldControl: async () => {
          yields += 1;
          fixture.takePointReads();
          cancelled = true;
        },
      },
    );
    expect(committed).toBe(false);
    expect(yields).toBe(1);
    expect(removals).toBe(0);
    expect(fixture.takePointReads()).toBe(0);
    expect(fixture.eraser.candidateCount).toBe(0);
    expect(fixture.eraser.retainedSweepCount).toBe(0);
    expect(fixture.eraser.retainedCandidateIdCount).toBe(0);
  } finally {
    fixture.eraser.revert();
  }
});
