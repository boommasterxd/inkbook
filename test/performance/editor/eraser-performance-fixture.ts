import type { StrokeElementV1 } from "../../../src/domain/schema/public";
import { EraserSweep, type EraserSliceScheduler } from "../../../src/editor/gestures/public";

export class MeasuredEraserScheduler implements EraserSliceScheduler {
  readonly #budgetMs: number;
  readonly #sliceDurationsMs: number[] = [];
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

  public get sliceDurationsMs(): readonly number[] {
    return this.#sliceDurationsMs;
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
    const duration = performance.now() - this.#sliceStarted;
    this.#sliceDurationsMs.push(duration);
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
