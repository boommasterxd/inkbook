import { describe, expect, it } from "vitest";

import type { BoxShapeElementV1, StrokeElementV1 } from "../../../src/domain/schema/public";
import { EraserSweep, type EraserSliceScheduler } from "../../../src/editor/gestures/public";
import { maximumStroke } from "./maximum-stroke-fixture";

declare const gc: (() => void) | undefined;

const DENSE_STROKES = 488;
const MAX_FRAME_MS = 16.7;

describe("eraser hot paths", () => {
  it("resumes exact checks for a dense two-million-point batch within the frame budget", () => {
    const strokes = Array.from({ length: DENSE_STROKES }, (_, index) => maximumStroke(index));
    const eraser = createDenseStrokeEraser(strokes);
    gc?.();
    const frameDurations: number[] = [];

    while (eraser.candidateCount < DENSE_STROKES) {
      const started = performance.now();
      eraser.update({ x: 5_000, y: 0 });
      frameDurations.push(performance.now() - started);
    }

    expect(eraser.candidateCount).toBe(DENSE_STROKES);
    expect(Math.max(...frameDurations)).toBeLessThanOrEqual(MAX_FRAME_MS);
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
        query: (_bounds, sink) => {
          queryIndex += 1;
          const id = ids[queryIndex - 2];
          if (id !== undefined) sink.add(id);
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
    const started = performance.now();
    for (let index = 0; index < count; index += 1)
      eraser.update({ x: index % 2 === 0 ? 100 : 0, y: 50 });
    const duration = performance.now() - started;

    expect(eraser.candidateCount).toBe(count);
    expect(addedCount).toBe(count);
    expect(fullSetUpdates).toBe(0);
    expect(duration).toBeLessThan(2_000);
  });
});

describe("eraser finalization performance", () => {
  it("keeps exact finalization slices within the mobile main-thread budget", async () => {
    const strokes = Array.from({ length: 128 }, (_, index) => maximumStroke(index));
    const eraser = createDenseStrokeEraser(strokes);
    eraser.update({ x: 5_000, y: 0 });
    const scheduler = new MeasuredEraserScheduler(4);
    let removed = 0;

    await eraser.commit((ids) => {
      removed = ids.size;
      return true;
    }, scheduler);
    scheduler.finish();

    expect(removed).toBe(strokes.length);
    expect(scheduler.yieldCount).toBeGreaterThan(0);
    expect(scheduler.maximumSliceMs).toBeLessThanOrEqual(12);
  });
});

class MeasuredEraserScheduler implements EraserSliceScheduler {
  readonly #budgetMs: number;
  #maximumSliceMs = 0;
  #sliceStarted = performance.now();
  #yieldCount = 0;

  public constructor(budgetMs: number) {
    this.#budgetMs = budgetMs;
  }

  public get maximumSliceMs(): number {
    return this.#maximumSliceMs;
  }

  public get yieldCount(): number {
    return this.#yieldCount;
  }

  public isCancelled(): boolean {
    return false;
  }

  public shouldYield(): boolean {
    return performance.now() - this.#sliceStarted >= this.#budgetMs;
  }

  public async yieldControl(): Promise<void> {
    this.#recordSlice();
    this.#yieldCount += 1;
    await Promise.resolve();
    this.#sliceStarted = performance.now();
  }

  public finish(): void {
    this.#recordSlice();
  }

  #recordSlice(): void {
    this.#maximumSliceMs = Math.max(this.#maximumSliceMs, performance.now() - this.#sliceStarted);
  }
}

function createDenseStrokeEraser(strokes: readonly StrokeElementV1[]): EraserSweep {
  const byId = new Map(strokes.map((stroke) => [stroke.id, stroke]));
  let queryCount = 0;
  return new EraserSweep(
    { x: -1_000, y: 0 },
    4,
    {
      getElement: (id) => byId.get(id),
      query: (_bounds, sink) => {
        if (queryCount++ === 1) for (const { id } of strokes) sink.add(id);
      },
    },
    {
      addCandidateFade: () => undefined,
      clearCandidateFade: () => undefined,
      setCandidateFade: () => undefined,
    },
  );
}

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
