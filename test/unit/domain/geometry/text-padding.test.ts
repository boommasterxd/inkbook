import { describe, expect, it } from "vitest";
import {
  expandLegacyTextPaddingSteps,
  textContentWidth,
  textPaddingForWidth,
} from "../../../../src/domain/geometry/text-padding";
import { rotatePointClockwise } from "../../../../src/domain/geometry/primitives";
import { validateInkElementV1 } from "../../../../src/domain/schema/public";
import { scaleElement } from "../../../../src/editor/selection/transform/transforms";
import { copyRuntimeElementSteps } from "../../../../src/domain/elements/runtime-element-copy";
import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";
import { textElement } from "../schema/fixtures";

describe("stored text padding", () => {
  it("reserves an em and a native-scale touch target within a canonical quarter-width bound", () => {
    expect(textPaddingForWidth(16.5, 200)).toBe(28);
    expect(textPaddingForWidth(40.5, 200)).toBe(40.5);
    expect(textPaddingForWidth(16.5, 100)).toBe(25);
    expect(textPaddingForWidth(16.5, 10)).toBe(2.5);
    expect(textPaddingForWidth(16.5, 5.003)).toBe(1.25);
    expect(textPaddingForWidth(16.5, 0)).toBe(0);
    expect(textContentWidth(100, 8.25)).toBe(83.5);
    expect(() => textContentWidth(10, 3)).toThrow(RangeError);
  });

  it.each([0, 30, 90])(
    "expands a legacy rectangle without moving glyphs or formulas at %s degrees",
    (rotation) => {
      const source = { ...textElement(), rotation };
      source.layout.math = [
        {
          start: 0,
          end: 5,
          display: false,
          x: 3,
          y: 4,
          width: 10,
          height: 10,
          paths: [{ d: "M0 0L10 10Z" }],
        },
      ];
      const expanded = finishGeometrySteps(expandLegacyTextPaddingSteps(source));
      expect(expanded).toMatchObject({
        x: 72,
        y: 72,
        width: 156,
        height: 106,
        pivot: source.pivot,
        layout: { padding: 28 },
      });
      expect(textPaddingForWidth(expanded.style.fontSize, expanded.width)).toBe(
        expanded.layout.padding,
      );
      const point = (element: typeof source) =>
        rotatePointClockwise(
          {
            x: element.x + element.layout.lines[0]!.x,
            y: element.y + element.layout.lines[0]!.y + element.layout.lines[0]!.baseline,
          },
          element.pivot,
          element.rotation,
        );
      expect(point(expanded)).toEqual(point(source));
      expect(expanded.x + expanded.layout.math![0]!.x).toBe(source.x + source.layout.math[0]!.x);
      expect(expanded.y + expanded.layout.math![0]!.y).toBe(source.y + source.layout.math[0]!.y);
      expect(expanded.layout.lines[0]!.runs).toBe(source.layout.lines[0]!.runs);
      expect(expanded.layout.math![0]!.paths).toBe(source.layout.math[0]!.paths);
      expect(validateInkElementV1(source).ok).toBe(true);
      expect(validateInkElementV1(expanded).ok).toBe(true);
      expect(finishGeometrySteps(expandLegacyTextPaddingSteps(expanded))).toBe(expanded);
    },
  );

  it("preserves explicit padding through capture and scales it together with typography", () => {
    const padded = finishGeometrySteps(expandLegacyTextPaddingSteps(textElement()));
    expect(finishGeometrySteps(copyRuntimeElementSteps(padded)).layout.padding).toBe(28);
    const scaled = scaleElement(padded, padded.pivot, { x: 2, y: 2 });
    expect(scaled).toMatchObject({ layout: { padding: 56 }, style: { fontSize: 33 } });
    expect(validateInkElementV1(scaled).ok).toBe(true);
    expect(validateInkElementV1({ ...padded, layout: { ...padded.layout, padding: -1 } }).ok).toBe(
      false,
    );
    expect(validateInkElementV1({ ...padded, layout: { ...padded.layout, padding: 40 } }).ok).toBe(
      false,
    );
  });

  it("expands an earlier explicit inset once while retaining wider intentional insets", () => {
    const source = textElement();
    source.layout.padding = 8;
    const expanded = finishGeometrySteps(expandLegacyTextPaddingSteps(source));
    expect(expanded.layout.padding).toBe(28);
    expect(textContentWidth(expanded.width, expanded.layout.padding)).toBe(84);
    expect(expanded.x + expanded.layout.lines[0]!.x).toBe(source.x + source.layout.lines[0]!.x);
    expect(expanded.y + expanded.layout.lines[0]!.y).toBe(source.y + source.layout.lines[0]!.y);
    expect(finishGeometrySteps(expandLegacyTextPaddingSteps(expanded))).toBe(expanded);
    const wider = { ...expanded, layout: { ...expanded.layout, padding: 30 } };
    expect(finishGeometrySteps(expandLegacyTextPaddingSteps(wider))).toBe(wider);
  });
});
