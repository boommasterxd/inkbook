import type { StrokeElementV1 } from "../../../src/domain/schema/public";
import { EraserSweep } from "../../../src/editor/gestures/public";

import { maximumStroke } from "./maximum-stroke-fixture";

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

export function createCountedDenseStrokeEraser(count: number, sliceBudgetMs?: () => number) {
  let pointReads = 0;
  const strokes = Array.from({ length: count }, (_, index) => {
    const stroke = maximumStroke(index);
    return {
      ...stroke,
      points: new Proxy(stroke.points, {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key) && Number(key) % 3 === 0) {
            pointReads += 1;
          }
          return Reflect.get(target, key, receiver) as unknown;
        },
      }),
    };
  });
  return {
    eraser: createDenseStrokeEraser(strokes, sliceBudgetMs),
    takePointReads() {
      const reads = pointReads;
      pointReads = 0;
      return reads;
    },
  };
}
