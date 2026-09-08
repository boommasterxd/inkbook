import { describe, expect, it } from "vitest";

import type { StrokeElementV1 } from "../../../src/domain/schema/public";
import { SelectionScaleGesture } from "../../../src/editor/selection/selection-scale";
import { INTERACTION_REFRESH_PROFILE, interactionP99 } from "../interaction-refresh-profile";
import { timingBudget } from "../timing-budget";
import { maximumStroke } from "./maximum-stroke-fixture";

describe("arbitrary-frame stroke scale materialization", () => {
  it.each([false, true])(
    "materializes a maximum rotated stroke within budget (typed=%s)",
    (typed) => {
      const source = maximumStroke(0);
      const element = {
        ...source,
        rotation: 37,
        points: (typed
          ? new Float64Array(source.points)
          : source.points) as StrokeElementV1["points"],
      };
      const pointer = { x: 4_100, y: 200 };
      const gesture = new SelectionScaleGesture(
        { anchor: { x: 0, y: 0 }, kind: "scale", position: "bottom-right", rotation: 0 },
        [element, maximumStroke(1)],
        pointer,
      );
      const factors = { x: 1.25, y: 0.75 };
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
      expect(interactionP99(durations)).toBeLessThanOrEqual(
        timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms),
      );
    },
  );
});
