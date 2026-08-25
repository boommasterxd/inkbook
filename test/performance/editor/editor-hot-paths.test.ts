import { describe, expect, it } from "vitest";

import { EraserSweep } from "../../../src/editor/gestures/public";
import { maximumStroke } from "./maximum-stroke-fixture";
import { createPassThroughMoveSession } from "./selection-session-fixture";
import { INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { timingBudget } from "../timing-budget";

describe("editor gesture hot paths", () => {
  it("bounds maximum-stroke preview and eraser work independently of sweep length", () => {
    const strokes = Array.from({ length: 256 }, (_, index) => maximumStroke(index));
    const byId = new Map(strokes.map((stroke) => [stroke.id, stroke]));
    const ids = strokes.map(({ id }) => id);
    const previewDurations: number[] = [];
    const eraserDurations: number[] = [];

    for (let run = 0; run < 6; run += 1) {
      const session = createPassThroughMoveSession(strokes, { x: -1_000, y: 0 });
      let started = performance.now();
      const preview = session.update({ x: 5_000, y: 0 });
      const previewDuration = performance.now() - started;

      started = performance.now();
      const eraser = new EraserSweep(
        { x: -1_000, y: 0 },
        4,
        (() => {
          let queryCount = 0;
          return {
            getElement: (id) => byId.get(id),
            query: (_bounds, sink) => {
              if (queryCount++ === 1) for (const id of ids) sink.add(id);
            },
          };
        })(),
        { clearCandidateFade: () => undefined, setCandidateFade: () => undefined },
      );
      eraser.update({ x: 5_000, y: 0 });
      const eraserDuration = performance.now() - started;
      while (eraser.candidateCount < strokes.length) {
        started = performance.now();
        eraser.update({ x: 5_000, y: 0 });
        eraserDurations.push(performance.now() - started);
      }
      expect(preview.exactPreviewTruncated).toBe(true);
      expect(eraser.candidateCount).toBe(256);
      if (run > 0) {
        previewDurations.push(previewDuration);
        eraserDurations.push(eraserDuration);
      }
    }

    expect(Math.max(...previewDurations)).toBeLessThanOrEqual(
      timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms),
    );
    expect(Math.max(...eraserDurations)).toBeLessThanOrEqual(timingBudget(250));
  });
});
