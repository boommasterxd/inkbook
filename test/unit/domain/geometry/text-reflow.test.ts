import { describe, expect, it } from "vitest";
import { preserveTextReflowOrigin } from "../../../../src/domain/geometry/text-reflow";
import { pointDistance, rotatePointClockwise } from "../../../../src/domain/geometry/primitives";
import { validateInkElementV1 } from "../../../../src/domain/schema/public";
import { textElement } from "../schema/fixtures";

describe("text reflow origin", () => {
  it.each([0, 30, 90])(
    "preserves the visible origin through growth and shrink at %s degrees",
    (rotation) => {
      const source = { ...textElement(), rotation };
      const origin = rotatePointClockwise(source, source.pivot, rotation);
      const layout = {
        ...source.layout,
        math: [
          {
            start: 0,
            end: 5,
            display: false,
            x: 8,
            y: 12,
            width: 20,
            height: 20,
            paths: [{ d: "M0 0L1 1" }],
          },
        ],
      };
      let previous = source;
      for (const height of [200.003, 21.001]) {
        const prepared = preserveTextReflowOrigin(previous, { ...previous, height, layout });
        expect(
          pointDistance(rotatePointClockwise(prepared, prepared.pivot, rotation), origin),
        ).toBeLessThanOrEqual(0.003);
        expect(prepared.layout).toBe(layout);
        expect(prepared.style).toBe(source.style);
        expect(validateInkElementV1(prepared).ok).toBe(true);
        previous = prepared;
      }
    },
  );
});
