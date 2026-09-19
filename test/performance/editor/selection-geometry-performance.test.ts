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

describe("pressure selection hot path", () => {
  it("selects a maximum pressure stroke through its first visible segment", () => {
    const target = maximumStroke(0);
    const area = createRectangleSelectionArea({ x: -1, y: 99 }, { x: 1, y: 101 });
    expect(elementMatchesSelectionArea(area, target, "touched")).toBe(true);
  });
});

describe("selection hot paths", () => {
  it("reduces a maximum coalesced lasso batch to bounded storage", () => {
    const samples = Array.from({ length: 4_096 }, (_, index) => ({
      x: index * 2,
      y: 40 + Math.sin(index / 12) * 24,
    }));
    const session = new LassoSelectionSession({ x: 0, y: 40 }, 1);
    session.appendBatch(samples);
    expect(session.points.length).toBeLessThanOrEqual(512);
    expect(session.points.length).toBeGreaterThan(0);
  });

  it("keeps the 10,000-stroke group overlay bounded", () => {
    const selected = Array.from({ length: 10_000 }, (_, index) => {
      const element = indexedStroke(index);
      return { bounds: calculateElementBounds(element), element };
    });
    const geometry = selectionOverlayGeometry(selected, 1);
    expect(geometry?.outline.kind).toBe("polygon");
    expect(geometry?.handles).toHaveLength(9);
    expect(selectionOverlayContainsPoint(selected, { x: 1_000, y: 100 })).toBe(true);
    expect(selectionOverlayContainsPoint(selected, { x: -1_000, y: -100 })).toBe(false);
  });
});
