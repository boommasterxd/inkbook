import type { StrokeElementV1 } from "../../../src/domain/schema/public";
import { EraserSweep, type EraserSliceScheduler } from "../../../src/editor/gestures/public";

import { performanceMode } from "../timing-budget";

export class MeasuredEraserScheduler implements EraserSliceScheduler {
  readonly #budgetMs: number;
  readonly #sliceDurationsMs: number[] = [];
  readonly #controlled = performanceMode() !== "reference";
  readonly #checkpointCounts: number[] = [];
  #checkpoints = 0;
  #maximumSliceMs = 0;
  #sliceStarted = performance.now();
  #yieldCount = 0;

  public constructor(budgetMs: number) {
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
      throw new RangeError("Slice budgets must be finite and positive.");
    }
    this.#budgetMs = budgetMs;
  }

  public get maximumSliceMs(): number {
    return this.#maximumSliceMs;
  }

  public get yieldCount(): number {
    return this.#yieldCount;
  }

  public get sliceDurationsMs(): readonly number[] {
    return this.#sliceDurationsMs;
  }

  public get checkpointCounts(): readonly number[] {
    return this.#checkpointCounts;
  }

  public isCancelled(): boolean {
    return false;
  }

  public shouldYield(): boolean {
    this.#checkpoints += 1;
    // 0.05 virtual ms per observed checkpoint is a test cost model, not device speed.
    return this.#controlled
      ? this.#checkpoints >= Math.ceil(this.#budgetMs / 0.05)
      : performance.now() - this.#sliceStarted >= this.#budgetMs;
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
    const duration = performance.now() - this.#sliceStarted;
    this.#sliceDurationsMs.push(duration);
    this.#checkpointCounts.push(this.#checkpoints);
    this.#checkpoints = 0;
    this.#maximumSliceMs = Math.max(this.#maximumSliceMs, duration);
  }
}

export function createDenseStrokeEraser(
  strokes: readonly StrokeElementV1[],
  sliceBudgetMs?: () => number,
): EraserSweep {
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
    sliceBudgetMs,
  );
}
