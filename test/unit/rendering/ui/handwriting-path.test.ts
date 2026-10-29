import { describe, expect, it } from "vitest";
import { ONBOARDING_STEPS } from "../../../../src/obsidian/embeds/active-editor/onboarding-steps";
import { handwritingDrawing } from "../../../../src/rendering/ui/handwriting-path";

const onboardingCopy = [
  ...ONBOARDING_STEPS.flatMap((step) => [step.title, ...step.lines]),
  "do you want to",
  "start a tour?",
];

describe("handwritten onboarding lettering", () => {
  it("represents every fixed label as bounded cubic pen strokes in writing order", () => {
    for (const text of [...onboardingCopy, "abcdefghijklmnopqrstuvwxyz !?.,'"]) {
      const drawing = handwritingDrawing(text);
      expect(drawing.strokes.length).toBeGreaterThan(0);
      expect(drawing.strokes[0]?.progressStart).toBe(0);
      expect(drawing.strokes[drawing.strokes.length - 1]?.progressEnd).toBeCloseTo(1);
      for (const [index, stroke] of drawing.strokes.entries()) {
        expect(stroke.path).toMatch(/^M[\d., -]+ C/);
        expect(stroke.progressEnd).toBeGreaterThan(stroke.progressStart);
        expect(stroke.progressStart).toBe(drawing.strokes[index - 1]?.progressEnd ?? 0);
        for (const pair of stroke.path.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)) {
          expect(Number(pair[1])).toBeGreaterThanOrEqual(0);
          expect(Number(pair[1])).toBeLessThanOrEqual(drawing.width);
          expect(Number(pair[2])).toBeGreaterThanOrEqual(0);
          expect(Number(pair[2])).toBeLessThanOrEqual(drawing.height);
        }
      }
    }
  });

  it("preserves spaces and allows an empty decorative label", () => {
    expect(handwritingDrawing("a a").width).toBeGreaterThan(handwritingDrawing("aa").width);
    expect(handwritingDrawing("").strokes).toEqual([]);
    expect(handwritingDrawing(" ").strokes).toEqual([]);
  });

  it("rejects unsupported copy and bounds work instead of silently dropping glyphs", () => {
    expect(() => handwritingDrawing("Hello")).toThrow("Unsupported handwriting glyph: H");
    expect(() => handwritingDrawing("a\nb")).toThrow("Unsupported handwriting glyph");
    expect(() => handwritingDrawing("a".repeat(121))).toThrow(RangeError);
  });
});
