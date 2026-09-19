import { describe, expect, it } from "vitest";

import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { pathPresentation } from "../../../../src/rendering/scene/element-presentation";
import { arrow } from "../../domain/schema/fixtures";
import { coordinateSystem, rectangle, table } from "../../domain/geometry/fixtures";
import { createAllElementSnapshot } from "../../persistence/serialization/fixtures";

describe("outline presentation", () => {
  it.each(["solid", "dashed", "dotted"] as const)(
    "rounds every %s contour while preserving dash spacing and filled arrow nodes",
    (outlineStyle) => {
      const elements = createAllElementSnapshot().elements.filter(
        (element) => "outlineStyle" in element.style,
      );
      elements.push({
        ...arrow(),
        startNode: "arrow",
        endNode: "arrow",
        style: { ...arrow().style, outlineWidth: 1 },
      });
      for (const element of elements) {
        if (!("outlineStyle" in element.style)) throw new Error("Expected an outline style.");
        element.style.outlineStyle = outlineStyle;
        const width = element.style.outlineWidth;
        for (const part of buildElementPathParts(element)) {
          const presentation = pathPresentation(element, part);
          const filledNode = part.paint === "fill";
          expect(presentation["stroke-linecap"], element.kind).toBe(filledNode ? null : "round");
          expect(presentation["stroke-linejoin"], element.kind).toBe(filledNode ? null : "round");
          const dash = outlineStyle === "dashed" ? `${4 * width} ${3 * width}` : `0 ${2.5 * width}`;
          expect(presentation["stroke-dasharray"], element.kind).toBe(
            filledNode || outlineStyle === "solid" ? null : dash,
          );
        }
      }
    },
  );

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
      "round",
    );
  });
});
