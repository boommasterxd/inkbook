import { layoutTextElement } from "../../../fixtures/editor/text-style";
import { expect, it } from "vitest";
import type { TextElementV2 } from "../../../../src/domain/schema/public";
import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { createDragElement, createFreehandElement } from "../../../../src/editor/tools/creation";
import {
  applySelectionStyleChange,
  applyToolStyleChange,
} from "../../../../src/editor/tools/style-change";
import { summarizeSelectionStyle } from "../../../../src/editor/tools/style-summary";
import { textElement } from "../../domain/schema/fixtures";

const identity = { id: "123e4567-e89b-42d3-a456-426614174000", createdAt: 0 };
const defaults = createBuiltInSettings().toolDefaults;

function text(): TextElementV2 {
  return textElement();
}

it("includes the field background when every glyph has a different inline background", async () => {
  const element = await layoutTextElement({
    ...text(),
    backgroundColor: { type: "rgba", value: "#AA3300FF" },
    backgroundOpacity: 0.7,
    ranges: [
      {
        start: 0,
        end: text().source.length,
        style: {
          backgroundColor: { type: "rgba", value: "#113399FF" },
          backgroundOpacity: 0.2,
        },
      },
    ],
  });
  expect(summarizeSelectionStyle([element])).toMatchObject({
    kind: "text",
    backgroundColor: "mixed",
    backgroundOpacity: "mixed",
  });
});

it("reports mixed inline backgrounds and clears only the selected whole-field property", async () => {
  const element = await layoutTextElement({
    ...text(),
    ranges: [
      {
        start: 0,
        end: 1,
        style: {
          backgroundColor: { type: "rgba", value: "#AA3300FF" },
          backgroundOpacity: 0.25,
          underline: true,
        },
      },
    ],
  });
  expect(summarizeSelectionStyle([element])).toMatchObject({
    kind: "text",
    backgroundColor: "mixed",
    backgroundOpacity: "mixed",
  });
  const recolored = applySelectionStyleChange([element], {
    property: "text-background-color",
    value: null,
  }).elements[0] as TextElementV2;
  expect(recolored.ranges[0]!.style).toMatchObject({ backgroundOpacity: 0.25, underline: true });
  expect(recolored.ranges[0]!.style).not.toHaveProperty("backgroundColor");
  expect(summarizeSelectionStyle([recolored])).toMatchObject({
    backgroundColor: null,
    backgroundOpacity: "mixed",
  });
  const opaque = applySelectionStyleChange([recolored], {
    property: "text-background-opacity",
    value: 1,
  }).elements[0] as TextElementV2;
  expect(opaque.ranges[0]!.style).toEqual({ underline: true });
  expect(summarizeSelectionStyle([opaque])).toMatchObject({
    backgroundColor: null,
    backgroundOpacity: 1,
  });
});

it("summarizes range overrides and applies absolute whole-field flags without redundant changes", async () => {
  const element = await layoutTextElement({
    ...text(),
    ranges: [{ start: 0, end: 1, style: { bold: true, fontSize: 25.125 } }],
  });
  expect(summarizeSelectionStyle([element])).toMatchObject({
    kind: "text",
    style: { bold: "mixed", fontSize: "mixed" },
  });
  const updated = applySelectionStyleChange([element], { property: "text-bold", value: false });
  expect(updated.changed).toBe(true);
  expect((updated.elements[0] as TextElementV2).ranges).toEqual([
    { start: 0, end: 1, style: { fontSize: 25.125 } },
  ]);
  const unchanged = applySelectionStyleChange(updated.elements, {
    property: "text-bold",
    value: false,
  });
  expect(unchanged).toEqual({ elements: updated.elements, changed: false });
  expect(unchanged.elements).toBe(updated.elements);
});

it("summarizes effective range precedence without unused base values", async () => {
  const element = await layoutTextElement({
    ...text(),
    ranges: [
      { start: 0, end: text().source.length, style: { bold: true } },
      { start: 1, end: 2, style: { bold: false } },
      { start: 0, end: text().source.length, style: { bold: true } },
    ],
  });
  expect(summarizeSelectionStyle([element])).toMatchObject({
    kind: "text",
    style: { bold: true },
  });
});

it("limits text and stroke intersections to foreground paint", () => {
  const pen = createFreehandElement({ identity, tool: "draw", samples: [10, 10, 0.5], defaults });
  const selection = [text(), pen];
  expect(summarizeSelectionStyle(selection)).toMatchObject({
    kind: "common",
    width: null,
    fill: null,
  });
  expect(() =>
    applySelectionStyleChange(selection, { property: "stroke-width", value: 8 }),
  ).toThrow(/not shared/);
  expect(() =>
    applySelectionStyleChange(selection, { property: "text-font-size", value: 32 }),
  ).toThrow(/not shared/);
  const changed = applySelectionStyleChange(selection, { property: "opacity", value: 0.25 });
  expect(changed.elements.map(({ style }) => ("opacity" in style ? style.opacity : null))).toEqual([
    0.25, 0.25,
  ]);
});

it("maps shared shape fill to the text background and retains mixed states", () => {
  const rectangle = createDragElement({
    identity,
    tool: "rectangle",
    start: { x: 100, y: 100 },
    end: { x: 300, y: 300 },
    defaults,
  });
  const selection = [text(), rectangle];
  expect(summarizeSelectionStyle(selection)).toMatchObject({
    kind: "common",
    fill: { color: null, opacity: "mixed" },
  });
  const result = applySelectionStyleChange(selection, {
    property: "fill-color",
    value: { type: "rgba", value: "#EF4444FF" },
  });
  expect((result.elements[0] as TextElementV2).backgroundColor).toEqual({
    type: "rgba",
    value: "#EF4444FF",
  });
  expect(result.elements[1]?.style).toMatchObject({
    fillColor: { type: "rgba", value: "#EF4444FF" },
  });
});

it("retains canonical fractional font sizes, applies justify and rejects invalid changes", () => {
  const result = applyToolStyleChange(defaults, "text", {
    property: "text-font-size",
    value: 23.125,
  });
  expect(result.toolValues.text.fontSize).toBe(23.125);
  expect(
    applyToolStyleChange(result.toolValues, "text", { property: "text-font-size", value: 23.125 })
      .changed,
  ).toBe(false);
  const aligned = applySelectionStyleChange([text()], {
    property: "text-alignment",
    value: "justify",
  });
  expect((aligned.elements[0] as TextElementV2).paragraphs).toEqual([
    { start: 0, alignment: "justify" },
  ]);
  expect(() =>
    applyToolStyleChange(defaults, "text", { property: "text-font-size", value: NaN }),
  ).toThrow();
  expect(() =>
    applyToolStyleChange(defaults, "draw", { property: "text-bold", value: true }),
  ).toThrow();
});
