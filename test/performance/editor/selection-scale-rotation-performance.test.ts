import { describe, expect, it } from "vitest";

import { SelectionScaleGesture } from "../../../src/editor/selection/selection-scale";
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
