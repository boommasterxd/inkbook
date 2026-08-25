import { describe, expect, it } from "vitest";

import type { BoxShapeElementV1 } from "../../../src/domain/schema/public";
import { EraserSweep } from "../../../src/editor/gestures/public";
import { maximumStroke } from "./maximum-stroke-fixture";
import { createDenseStrokeEraser } from "./eraser-performance-fixture";
import { INTERACTION_REFRESH_PROFILE, interactionP99 } from "../interaction-refresh-profile";
import { timingBudget } from "../timing-budget";

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
    expect(interactionP99(frameDurations)).toBeLessThanOrEqual(
      timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms),
    );
    expect(Math.max(...frameDurations)).toBeLessThanOrEqual(timingBudget(MAX_FRAME_MS));
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
    expect(duration).toBeLessThan(timingBudget(2_000));
  });
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
