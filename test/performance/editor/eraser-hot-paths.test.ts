import { FILE_SCHEMA_LIMITS, MAX_STROKE_POINTS } from "../../../src/domain/schema/public";
import { eraserQuery } from "../../fixtures/editor/eraser-query";
import { describe, expect, it, vi } from "vitest";

import type { BoxShapeElementV1 } from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import { EraserSweep } from "../../../src/editor/gestures/public";
import { createCountedDenseStrokeEraser } from "./eraser-performance-fixture";

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
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
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
    );
    let passes = 0;
    try {
      expect(eraser.candidateCount).toBeLessThan(store.size);
      while (true) {
        expect(indexWork + reads).toBeLessThanOrEqual(12_288);
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
      clock.mockRestore();
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

// Preserve the original density cases and exercise the new per-stroke maximum within
// the document's aggregate point capacity, rather than quadrupling that capacity.
it.each([
  [16, ORIGINAL_STROKE_POINTS],
  [128, ORIGINAL_STROKE_POINTS],
  [488, ORIGINAL_STROKE_POINTS],
  [Math.floor(FILE_SCHEMA_LIMITS.strokePoints / MAX_STROKE_POINTS), MAX_STROKE_POINTS],
])("bounds exact point visits per update for %i strokes of %i points", (count, pointCount) => {
  expect(count * pointCount).toBeLessThanOrEqual(FILE_SCHEMA_LIMITS.strokePoints);
  const fixture = createCountedDenseStrokeEraser(count, undefined, pointCount);
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
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
      expect(reads).toBeLessThanOrEqual(workPerUpdate + setupReads);
      expect(fixture.eraser.retainedCandidateIdCount).toBeLessThanOrEqual(count);
      expect(fixture.eraser.retainedSweepCount).toBeLessThanOrEqual(1);
      totalReads += reads;
      updates += 1;
    }
    expect(totalReads).toBeGreaterThanOrEqual(count * segmentsPerStroke);
    // The immutable stroke width is resolved once per candidate, not once per segment.
    expect(fixture.widthReads).toBe(count);
  } finally {
    fixture.eraser.revert();
    clock.mockRestore();
  }
});

function rectangle(): BoxShapeElementV1 {
  return {
    createdAt: 1,
    height: 20,
    id: "shape",
    kind: "rectangle",
    pivot: { x: 50, y: 50 },
    rotation: 0,
    style: {
      fillColor: null,
      fillOpacity: 0,
      outlineColor: { type: "theme-text" },
      outlineOpacity: 1,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
    width: 20,
    x: 40,
    y: 40,
  };
}
