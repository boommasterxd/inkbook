import { describe, expect, it, vi } from "vitest";

import type { BoxShapeElementV1 } from "../../../src/domain/schema/public";
import { EraserSweep } from "../../../src/editor/gestures/public";
import { maximumStroke } from "./maximum-stroke-fixture";
import {
  createCountedDenseStrokeEraser,
  createDenseStrokeEraser,
} from "./eraser-performance-fixture";
import { INTERACTION_REFRESH_PROFILE, interactionP99 } from "../interaction-refresh-profile";
import { expectTiming, recordRelativeTiming } from "../timing-assertions";

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
    expectTiming(interactionP99(frameDurations), INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    expectTiming(Math.max(...frameDurations), MAX_FRAME_MS);
    recordRelativeTiming(
      frameDurations.reduce((total, duration) => total + duration, 0),
      "complete dense eraser batch active-frame elapsed time",
    );
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
    expectTiming(duration, 2_000, { exclusive: true });
  });
});

it.each([16, 128])("bounds exact point visits per update for %i maximum strokes", (count) => {
  const fixture = createCountedDenseStrokeEraser(count);
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const segmentsPerStroke = 4_095;
  const workPerUpdate = 12_288;
  // Each newly opened stroke reads two initial x coordinates in addition to its segments.
  const setupReads = 2 * (Math.ceil(workPerUpdate / segmentsPerStroke) + 1);
  let updates = 0;
  let totalReads = 0;
  try {
    while (fixture.eraser.candidateCount < count) {
      expect(updates).toBeLessThan(Math.ceil((count * segmentsPerStroke) / workPerUpdate) + 1);
      expect(fixture.eraser.update({ x: 5_000, y: 0 })).toBe("accepted");
      const reads = fixture.takePointReads();
      expect(reads).toBeGreaterThan(0);
      expect(reads).toBeLessThanOrEqual(workPerUpdate + setupReads);
      expect(fixture.eraser.retainedCandidateIdCount).toBeLessThanOrEqual(count);
      expect(fixture.eraser.retainedSweepCount).toBeLessThanOrEqual(1);
      totalReads += reads;
      updates += 1;
    }
    expect(totalReads).toBeGreaterThanOrEqual(count * segmentsPerStroke);
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
