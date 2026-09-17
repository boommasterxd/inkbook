import { describe, expect, it } from "vitest";

import { calculateElementBounds } from "../../../src/domain/geometry/public";
import { LassoSelectionSession } from "../../../src/editor/selection/lasso-selection-session";
import {
  selectionOverlayContainsPoint,
  selectionOverlayGeometry,
} from "../../../src/editor/selection/overlay-geometry";
import {
  createRectangleSelectionArea,
  elementMatchesSelectionArea,
} from "../../../src/editor/selection/selection-area";
import { indexedStroke } from "../../fixtures/editor/stroke";
import { maximumStroke } from "./maximum-stroke-fixture";
import { INTERACTION_REFRESH_PROFILE, interactionP99 } from "../interaction-refresh-profile";
import { expectTiming } from "../timing-assertions";

describe("pressure selection hot path", () => {
  it("stops pressure sweep selection at the first visible segment of a maximum stroke", () => {
    const target = maximumStroke(0);
    const area = createRectangleSelectionArea({ x: -1, y: 99 }, { x: 1, y: 101 });
    for (let index = 0; index < 20; index += 1) {
      elementMatchesSelectionArea(area, target, "touched");
    }
    const durations = new Array<number>(120);
    let incorrectSelections = 0;
    for (let run = 0; run < durations.length; run += 1) {
      const started = performance.now();
      const selected = elementMatchesSelectionArea(area, target, "touched");
      durations[run] = performance.now() - started;
      if (selected !== true) incorrectSelections += 1;
    }

    expect(incorrectSelections).toBe(0);
    expectTiming(interactionP99(durations), INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
  });
});

describe("selection hot paths", () => {
  it("reduces a maximum coalesced lasso batch within one interaction budget", () => {
    const samples = Array.from({ length: 4_096 }, (_, index) => ({
      x: index * 2,
      y: 40 + Math.sin(index / 12) * 24,
    }));
    new LassoSelectionSession({ x: 0, y: 40 }, 1).appendBatch(samples);
    const durations = new Array<number>(120);
    let oversizedSelections = 0;
    for (let run = 0; run < durations.length; run += 1) {
      const session = new LassoSelectionSession({ x: 0, y: 40 }, 1);
      const started = performance.now();
      session.appendBatch(samples);
      durations[run] = performance.now() - started;
      if (!(session.points.length <= 512)) oversizedSelections += 1;
    }

    expect(oversizedSelections).toBe(0);
    expectTiming(interactionP99(durations), INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
  });

  it("keeps the 10,000-stroke group overlay within the interaction budget", () => {
    const selected = Array.from({ length: 10_000 }, (_, index) => {
      const element = indexedStroke(index);
      return { bounds: calculateElementBounds(element), element };
    });
    selectionOverlayGeometry(selected, 1);
    const durations = Array.from({ length: 120 }, () => {
      const started = performance.now();
      const geometry = selectionOverlayGeometry(selected, 1);
      const duration = performance.now() - started;
      expect(geometry?.outline.kind).toBe("polygon");
      expect(geometry?.handles).toHaveLength(9);
      return duration;
    });
    const center = { x: 1_000, y: 100 };
    selectionOverlayContainsPoint(selected, center);
    const hitDurations = Array.from({ length: 120 }, () => {
      const started = performance.now();
      const containsPoint = selectionOverlayContainsPoint(selected, center);
      const duration = performance.now() - started;
      expect(containsPoint).toBe(true);
      return duration;
    });

    expectTiming(interactionP99(durations), INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    expectTiming(interactionP99(hitDurations), INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
  });
});
