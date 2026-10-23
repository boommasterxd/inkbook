import { describe, expect, it } from "vitest";

import { LassoSelectionSession } from "../../../../../src/editor/selection/public";
import { MAX_LASSO_SELECTION_POINTS } from "../../../../../src/editor/selection/query/selection-area";

describe("LassoSelectionSession", () => {
  it("processes dense batches within a bounded deterministic point budget", () => {
    const samples = Array.from({ length: 4_096 }, (_, index) => ({
      x: index * 2,
      y: index % 4 < 2 ? 20 : 28,
    }));
    const first = new LassoSelectionSession({ x: 0, y: 20 }, 1);
    const second = new LassoSelectionSession({ x: 0, y: 20 }, 1);

    expect(first.appendBatch(samples)).toBe(true);
    second.appendBatch(samples);

    expect(first.points.length).toBeLessThanOrEqual(MAX_LASSO_SELECTION_POINTS);
    expect(first.points).toEqual(second.points);
    expect(first.points[0]).toEqual({ x: 0, y: 20 });
    const retainedEnd = first.points[first.points.length - 1]!;
    const inputEnd = samples[samples.length - 1]!;
    expect(Math.hypot(retainedEnd.x - inputEnd.x, retainedEnd.y - inputEnd.y)).toBeLessThanOrEqual(
      3,
    );
  });

  it("keeps sampling tolerance in screen space", () => {
    const lowZoom = new LassoSelectionSession({ x: 0, y: 0 }, 1);
    const highZoom = new LassoSelectionSession({ x: 0, y: 0 }, 4);

    expect(lowZoom.append({ x: 1, y: 0 })).toBe(false);
    expect(highZoom.append({ x: 1, y: 0 })).toBe(true);
  });

  it("produces a validated selection area and rejects invalid construction", () => {
    const session = new LassoSelectionSession({ x: 0, y: 0 }, 1);
    session.appendBatch([
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ]);

    expect(session.selectionArea()).toMatchObject({
      bounds: { maxX: 20, maxY: 20, minX: 0, minY: 0 },
      kind: "lasso",
    });
    expect(() => new LassoSelectionSession({ x: 0, y: 0 }, 0)).toThrow(RangeError);
    expect(() => session.append({ x: Number.NaN, y: 0 })).toThrow(RangeError);
  });
});
