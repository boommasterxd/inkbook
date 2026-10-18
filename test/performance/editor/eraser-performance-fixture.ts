import { eraserQuery } from "../../fixtures/editor/eraser-query";
import { MAX_STROKE_POINTS, type StrokeElementV1 } from "../../../src/domain/schema/public";
import { EraserSweep } from "../../../src/editor/gestures/public";
import { markStoredStroke } from "../../../src/domain/elements/stroke-replacement-proof";

import { denseStrokePoints, maximumStroke } from "./maximum-stroke-fixture";

export function createDenseStrokeEraser(
  strokes: readonly StrokeElementV1[],
  sliceBudgetMs?: () => number,
  updateShouldYield?: () => boolean,
): EraserSweep {
  const byId = new Map(strokes.map((stroke) => [stroke.id, stroke]));
  let queryCount = 0;
  return new EraserSweep(
    { x: -1_000, y: 0 },
    4,
    {
      getElement: (id) => byId.get(id),
      beginQuery: () => eraserQuery(queryCount++ === 1 ? strokes.map(({ id }) => id) : []),
    },
    {
      addCandidateFade: () => undefined,
      clearCandidateFade: () => undefined,
      setCandidateFade: () => undefined,
    },
    sliceBudgetMs,
    updateShouldYield,
  );
}

export function createCountedDenseStrokeEraser(
  count: number,
  sliceBudgetMs?: () => number,
  pointCount: number = MAX_STROKE_POINTS,
  updateShouldYield?: (pointReads: number) => boolean,
) {
  let pointReads = 0;
  let widthReads = 0;
  const strokes = Array.from({ length: count }, (_, index) => {
    const stroke = maximumStroke(index, denseStrokePoints(index, pointCount));
    return countedEraserStroke(
      {
        ...stroke,
        style: {
          ...stroke.style,
          get width() {
            widthReads += 1;
            return stroke.style.width;
          },
        },
      },
      () => {
        pointReads += 1;
      },
    );
  });
  return {
    eraser: createDenseStrokeEraser(
      strokes,
      sliceBudgetMs,
      () => updateShouldYield?.(pointReads) ?? false,
    ),
    get widthReads() {
      return widthReads;
    },
    takePointReads() {
      const reads = pointReads;
      pointReads = 0;
      return reads;
    },
  };
}

export function countedEraserStroke(
  stroke: StrokeElementV1,
  pointRead: () => void,
): StrokeElementV1 {
  // The fixture exclusively owns frozen samples, matching Store ownership. The
  // proxy observes actual sample accesses without changing the stored proof.
  Object.freeze(stroke.points);
  return markStoredStroke({
    ...stroke,
    points: new Proxy(stroke.points, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key) && Number(key) % 3 === 0) pointRead();
        return Reflect.get(target, key, receiver) as unknown;
      },
    }),
  });
}
