import { describe, expect, it, vi } from "vitest";

import { ElementStore } from "../../../src/domain/store/public";
import {
  createRectangleSelectionArea,
  selectBySelectionAreaCandidatesSteps,
  type SelectionAreaCandidate,
} from "../../../src/editor/selection/public";
import { SelectionQueryWork } from "../../../src/obsidian/embeds/active-editor/selection-query-work";
import { indexedStroke } from "../../fixtures/editor/stroke";
import { ManualFrameScheduler } from "../../fixtures/obsidian/manual-frame-scheduler";
import { INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";

const profile = INTERACTION_REFRESH_PROFILE;

describe(`${profile.refreshRate} Hz selection-query scheduling`, () => {
  it.for(["deadline", "hard-cap", "over-budget"] as const)(
    "bounds actual selection iterator work at the %s checkpoint and releases cancellation",
    (checkpoint) => {
      const targets = Array.from({ length: 1000 }, (_, index) => indexedStroke(index));
      const store = new ElementStore(targets);
      const scheduler = new ManualFrameScheduler();
      const controller = new AbortController();
      const selection = new Set<string>();
      const publish = vi.fn();
      const closed = vi.fn();
      const read = vi.spyOn(store, "get");
      function* candidates(): Generator<SelectionAreaCandidate, boolean> {
        try {
          for (const target of targets) {
            const record = store.get(target.id)!;
            yield { id: target.id, bounds: record.bounds, element: target };
          }
          return true;
        } finally {
          closed();
        }
      }
      const steps = selectBySelectionAreaCandidatesSteps(
        selection,
        createRectangleSelectionArea({ x: 0, y: 0 }, { x: 2000, y: 2000 }),
        "fully-enclosed",
        false,
        candidates(),
      );
      const next = steps.next.bind(steps);
      let simulatedNow = 0;
      // Inject scheduling checkpoints only; these ticks do not measure execution speed.
      const increment = checkpoint === "deadline" ? 1 : checkpoint === "hard-cap" ? 0 : 100;
      const advance = vi.spyOn(steps, "next").mockImplementation(() => {
        const result = next();
        simulatedNow += increment;
        return result;
      });
      const work = new SelectionQueryWork(
        {
          frameScheduler: scheduler,
          selection: () => selection,
          selectionSignal: controller.signal,
          selectionWorkBudget: {
            now: () => simulatedNow,
            sliceBudgetMs: () => profile.interruptibleSliceDeadlineMs,
          },
          setSelection: publish,
          store,
        },
        steps,
      );
      const expected =
        checkpoint === "deadline"
          ? Math.ceil(profile.interruptibleSliceDeadlineMs)
          : checkpoint === "hard-cap"
            ? 64
            : 1;
      work.start();
      expect(advance).toHaveBeenCalledTimes(expected);
      expect(scheduler.pendingCount).toBe(1);
      scheduler.runNext(profile.frameDurationMs);
      expect(advance).toHaveBeenCalledTimes(expected * 2);
      expect(read.mock.calls.length).toBeGreaterThan(0);
      expect(read.mock.calls.length).toBeLessThanOrEqual(expected * 2);
      controller.abort();
      expect(scheduler.pendingCount).toBe(0);
      expect(closed).toHaveBeenCalledOnce();
      expect(publish).not.toHaveBeenCalled();
      expect(advance).toHaveBeenCalledTimes(expected * 2);
    },
  );
});
