import { describe, expect, it } from "vitest";

import { SelectionScaleGesture } from "../../../src/editor/selection/selection-scale";
import { INTERACTION_REFRESH_PROFILE, interactionP99 } from "../interaction-refresh-profile";
import { expectTiming } from "../timing-assertions";
import { createRotatedScaleFixture } from "./selection-input-fixture";

describe("arbitrary-frame stroke scale materialization", () => {
  it.each([false, true])(
    "materializes a maximum rotated stroke within budget (typed=%s)",
    (typed) => {
      const { element, pointer, gesture, factors } = createRotatedScaleFixture(
        typed,
        SelectionScaleGesture,
      );
      for (let warmup = 0; warmup < 30; warmup += 1) {
        gesture.materializeOne(element, pointer, false, factors);
      }
      const durations = Array.from({ length: 120 }, () => {
        const started = performance.now();
        const result = gesture.materializeOne(element, pointer, false, factors);
        const duration = performance.now() - started;
        expect(result.kind).toBe("stroke");
        if (result.kind !== "stroke") throw new Error("Expected a stroke replacement.");
        expect(result.rotation).toBe(0);
        expect(result.points).toHaveLength(4_096 * 3);
        expect(result.points).not.toBe(element.points);
        return duration;
      });
      expectTiming(interactionP99(durations), INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    },
  );
});
