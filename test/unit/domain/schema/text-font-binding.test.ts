import { describe, expect, it } from "vitest";
import { validateInkElementV1 } from "../../../../src/domain/schema/public";
import { copyRuntimeElementSteps } from "../../../../src/domain/elements/runtime-element-copy";
import {
  moveSelection,
  rotateSelection,
  scaleElement,
} from "../../../../src/editor/selection/transform/transforms";
import { textElement } from "./fixtures";
import { SelectionScaleGesture } from "../../../../src/editor/selection/transform/selection-scale";

const FONT_ID = "1a".repeat(32);
const BASE_FONT_ID = "2b".repeat(32);

describe("text layout font bindings", () => {
  it("accepts optional lowercase content-hash bindings without resolving resources in domain validation", () => {
    const text = textElement();
    expect(validateInkElementV1(text).ok).toBe(true);
    text.layout.lines[0]!.runs[0]!.fontResourceId = FONT_ID;
    expect(validateInkElementV1(text).ok).toBe(true);
  });

  it.each([FONT_ID.toUpperCase(), FONT_ID.slice(1), `${FONT_ID}0`, "z".repeat(64), 123])(
    "rejects malformed font binding %s",
    (fontResourceId) => {
      const text = textElement();
      const value = {
        ...text,
        layout: {
          ...text.layout,
          lines: [
            {
              ...text.layout.lines[0],
              runs: [{ ...text.layout.lines[0]!.runs[0], fontResourceId }],
            },
          ],
        },
      };
      expect(validateInkElementV1(value)).toMatchObject({
        ok: false,
        error: { code: "invalid-range", path: "$.layout.lines[0].runs[0].fontResourceId" },
      });
    },
  );

  it("accepts and validates an explicit base face for an empty field", () => {
    const text = textElement();
    text.source = "";
    text.layout = { version: 1, lines: [], baseFontResourceId: FONT_ID };
    expect(validateInkElementV1(text).ok).toBe(true);
    text.layout.baseFontResourceId = FONT_ID.toUpperCase();
    expect(validateInkElementV1(text)).toMatchObject({
      ok: false,
      error: { code: "invalid-range", path: "$.layout.baseFontResourceId" },
    });
  });

  it("retains bound glyph and base faces through copy and synchronous or scheduled geometry transforms", async () => {
    const text = textElement();
    text.layout.baseFontResourceId = BASE_FONT_ID;
    text.layout.lines[0]!.runs[0]!.fontResourceId = FONT_ID;
    const copy = copyRuntimeElementSteps(text);
    let copied = copy.next();
    while (!copied.done) copied = copy.next();
    const gesture = new SelectionScaleGesture(
      { kind: "scale", position: "bottom-right", anchor: { x: 100, y: 100 }, rotation: 0 },
      [text],
      { x: 200, y: 150 },
    );
    const scheduled = await gesture.materializeOneTimeSliced(
      text,
      { x: 300, y: 200 },
      false,
      undefined,
      { shouldYield: () => false, yieldControl: () => Promise.resolve() },
    );
    if (scheduled === null) throw new Error("Expected a completed text scale.");
    const transformed = [
      copied.value,
      scheduled,
      moveSelection([text], { x: 10, y: 20 })[0]!,
      rotateSelection([text], text.pivot, 30)[0]!,
      scaleElement(text, text.pivot, { x: 2, y: 2 }),
    ];
    for (const element of transformed) {
      if (element.kind !== "text")
        throw new Error("Text transforms must preserve the element kind.");
      expect(element.layout.lines[0]!.runs[0]!.fontResourceId).toBe(FONT_ID);
      expect(element.layout.baseFontResourceId).toBe(BASE_FONT_ID);
    }
  });
});
