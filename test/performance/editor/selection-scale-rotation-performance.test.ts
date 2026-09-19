import { describe, expect, it } from "vitest";

import { SelectionScaleGesture } from "../../../src/editor/selection/selection-scale";
import { table } from "../../unit/domain/schema/fixtures";
import { createRotatedScaleFixture } from "./selection-input-fixture";

describe("arbitrary-frame stroke scale materialization", () => {
  it.each([false, true])(
    "materializes a maximum rotated stroke with one source-coordinate copy (typed=%s)",
    (typed) => {
      const { element, pointer, gesture, factors } = createRotatedScaleFixture(
        typed,
        SelectionScaleGesture,
      );
      let copiedCoordinates = 0;
      const points = new Proxy(element.points, {
        get(target, key) {
          if (key === "slice")
            return () => {
              copiedCoordinates += target.length;
              return target.slice();
            };
          return Reflect.get(target, key, target) as unknown;
        },
      });
      const result = gesture.materializeOne({ ...element, points }, pointer, false, factors);
      expect(copiedCoordinates).toBe(4_096 * 3);
      expect(result.kind).toBe("stroke");
      if (result.kind !== "stroke") throw new Error("Expected a stroke replacement.");
      expect(result.rotation).toBe(0);
      expect(result.points).toHaveLength(4_096 * 3);
      expect(result.points).not.toBe(element.points);
    },
  );
});

describe("collapsed structural scale work", () => {
  it("reuses the prepared basis without revisiting maximum table geometry", () => {
    let sourceReads = 0;
    const source = new Proxy(
      {
        ...table(),
        columns: 12,
        columnWidth: 0,
        height: 0,
        headerHeight: 0,
        x: 100,
        y: 100,
        pivot: { x: 100, y: 100 },
        columnOffsets: Array<number>(11).fill(0),
      },
      {
        get(target, key, receiver): unknown {
          sourceReads += 1;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const gesture = new SelectionScaleGesture(
      { anchor: { x: 99, y: 99 }, kind: "scale", position: "bottom-right", rotation: 0 },
      [source],
      { x: 101, y: 101 },
    );
    sourceReads = 0;
    for (const pointer of [
      { x: 101.1, y: 101.1 },
      { x: 221, y: 221 },
      { x: 99, y: 99 },
    ]) {
      const factors = gesture.previewFactors(pointer, false, true);
      expect(factors.x).toBeGreaterThanOrEqual(0);
      expect(factors.y).toBeGreaterThanOrEqual(0);
    }
    // Both solver and preview frame use the prepared constant-size basis, not column data.
    expect(sourceReads).toBe(0);
  });
});
