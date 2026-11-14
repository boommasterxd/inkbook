import { describe, expect, it } from "vitest";
import {
  expandLegacyTextPaddingSteps,
  textContentWidth,
  textPaddingForWidth,
} from "../../../../src/domain/geometry/text-padding";
import { pointDistance, rotatePointClockwise } from "../../../../src/domain/geometry/primitives";
import { validateInkElementV1 } from "../../../../src/domain/schema/public";
import { scaleElement } from "../../../../src/editor/selection/transform/transforms";
import { copyRuntimeElementSteps } from "../../../../src/domain/elements/runtime-element-copy";
import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";
import { textElement } from "../schema/fixtures";

function firstGlyphPoint(element: ReturnType<typeof textElement>) {
  const line = element.layout.lines[0]!;
  return rotatePointClockwise(
    { x: element.x + line.x, y: element.y + line.y + line.baseline },
    element.pivot,
    element.rotation,
  );
}

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
      expect(firstGlyphPoint(expanded)).toEqual(firstGlyphPoint(source));
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

it.each([0, 30])(
  "keeps a fractional scaled field valid when increasing its inset at %s degrees",
  (rotation) => {
    const fixture = textElement();
    const source = {
      ...fixture,
      x: 478.914,
      y: 707.584,
      width: 601.178,
      height: 638.817,
      pivot: { x: 779.503, y: 1026.992 },
      rotation,
      style: { ...fixture.style, fontSize: 14.376 },
      layout: {
        ...fixture.layout,
        padding: 25.537,
        lines: fixture.layout.lines.map((line) => ({ ...line, x: 25.537, y: 25.537 })),
      },
    };
    expect(validateInkElementV1(source).ok).toBe(true);
    const expanded = finishGeometrySteps(expandLegacyTextPaddingSteps(source));
    expect(expanded).toMatchObject({
      x: 476.451,
      y: 705.121,
      width: 606.104,
      height: 643.743,
      pivot: { x: 779.503, y: 1026.993 },
      layout: { padding: 28 },
    });
    expect(validateInkElementV1(expanded).ok).toBe(true);
    expect(pointDistance(firstGlyphPoint(expanded), firstGlyphPoint(source))).toBeLessThanOrEqual(
      0.003,
    );
    expect(textContentWidth(expanded.width, expanded.layout.padding)).toBe(
      textContentWidth(source.width, source.layout.padding),
    );
    expect(finishGeometrySteps(expandLegacyTextPaddingSteps(expanded))).toBe(expanded);
  },
);
