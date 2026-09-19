import { describe, expect, it } from "vitest";

import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { pathPresentation } from "../../../../src/rendering/scene/element-presentation";
import { coordinateSystem, rectangle, table } from "../../domain/geometry/fixtures";

describe("point outline presentation", () => {
  it("gives collapsed shapes solid round caps while preserving extended shape paint", () => {
    const origin = { x: 0, y: 0 };
    const system = coordinateSystem();
    system.origin = origin;
    system.axes = [origin, origin];
    const elements = [
      rectangle({ width: 0, height: 0 }),
      table({ columnWidth: 0, height: 0, headerHeight: 0 }),
      system,
    ];
    for (const element of elements) {
      for (const outlineStyle of ["solid", "dashed", "dotted"] as const) {
        const point = structuredClone(element);
        point.style.outlineStyle = outlineStyle;
        const presentation = pathPresentation(point, buildElementPathParts(point)[0]!);
        expect(presentation["stroke-linecap"]).toBe("round");
        expect(presentation["stroke-dasharray"]).toBeNull();
      }
    }
    const extended = rectangle();
    expect(pathPresentation(extended, buildElementPathParts(extended)[0]!)["stroke-linecap"]).toBe(
      "butt",
    );
  });
});
