import { describe, expect, it } from "vitest";

import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { createDragElement, createFreehandElement } from "../../../../src/editor/tools/creation";
import {
  applySelectionStyleChange,
  type StyleChange,
} from "../../../../src/editor/tools/style-change";

const defaults = createBuiltInSettings().toolDefaults;
const identity = { id: "123e4567-e89b-42d3-a456-426614174000", createdAt: 0 };
const pen = createFreehandElement({ identity, tool: "draw", samples: [10, 10, 0.5], defaults });
const highlighter = createFreehandElement({
  identity: { ...identity, id: "123e4567-e89b-42d3-a456-426614174001" },
  tool: "highlighter",
  samples: [20, 20, 0.5],
  defaults,
});
const rectangle = createDragElement({
  identity: { ...identity, id: "123e4567-e89b-42d3-a456-426614174002" },
  tool: "rectangle",
  start: { x: 100, y: 100 },
  end: { x: 200, y: 200 },
  defaults,
});
const straight = createDragElement({
  identity: { ...identity, id: "123e4567-e89b-42d3-a456-426614174003" },
  tool: "straight-highlighter",
  start: { x: 100, y: 100 },
  end: { x: 200, y: 100 },
  defaults,
});
const selection = [pen, highlighter, straight, rectangle];

const commonChanges = [
  {
    change: { property: "color", value: { type: "rgba", value: "#FF00AAFF" } },
    stroke: { color: { type: "rgba", value: "#FF00AAFF" } },
    outline: { outlineColor: { type: "rgba", value: "#FF00AAFF" } },
  },
  {
    change: { property: "stroke-width", value: 8 },
    stroke: { width: 8 },
    outline: { outlineWidth: 8 },
  },
  {
    change: { property: "opacity", value: 0.12345 },
    stroke: { opacity: 0.1235 },
    outline: { outlineOpacity: 0.1235 },
  },
] as const;

describe("mixed selection paint", () => {
  it.each(commonChanges)(
    "applies $change.property to stroke paint and shape outlines",
    ({ change, stroke, outline }) => {
      const before = structuredClone(selection);
      const result = applySelectionStyleChange(selection, change);
      expect(result.changed).toBe(true);
      for (let index = 0; index < selection.length; index += 1) {
        const original = selection[index]!;
        expect(result.elements[index]).toEqual({
          ...original,
          style: { ...original.style, ...(original.kind === "rectangle" ? outline : stroke) },
        });
      }
      expect(selection).toEqual(before);
      const repeated = applySelectionStyleChange(result.elements, change);
      expect(repeated.changed).toBe(false);
      expect(repeated.elements).toBe(result.elements);
    },
  );

  it("retains unchanged element identity when only part of the selection needs updating", () => {
    const result = applySelectionStyleChange(selection, { property: "stroke-width", value: 4 });
    expect(result.changed).toBe(true);
    expect(result.elements[0]).toBe(pen);
    expect(result.elements[3]).toBe(rectangle);
    expect(result.elements[1]).not.toBe(highlighter);
    expect(result.elements[2]).not.toBe(straight);
  });

  it("rejects family-specific properties without partially mutating a mixed selection", () => {
    const before = structuredClone(selection);
    const changes: StyleChange[] = [
      { property: "outline-color", value: { type: "theme-text" } },
      { property: "outline-width", value: 8 },
      { property: "outline-opacity", value: 0.5 },
      { property: "outline-style", value: "dashed" },
      { property: "fill-color", value: null },
      { property: "pressure-enabled", value: false },
      { property: "arrow-end-node", value: "circle" },
    ];
    for (const change of changes) {
      expect(() => applySelectionStyleChange(selection, change)).toThrow(/not shared/);
    }
    expect(selection).toEqual(before);
  });

  it("rejects invalid common values atomically", () => {
    const before = structuredClone(selection);
    const changes: StyleChange[] = [
      { property: "opacity", value: Number.NaN },
      { property: "opacity", value: -0.1 },
      { property: "opacity", value: 1.1 },
      { property: "color", value: { type: "rgba", value: "#invalid" } },
      { property: "stroke-width", value: 0 as never },
    ];
    for (const change of changes) {
      expect(() => applySelectionStyleChange(selection, change)).toThrow();
    }
    expect(selection).toEqual(before);
  });
});

describe("runtime stroke Style validation", () => {
  it("rejects malformed runtime point buffers without modifying the selection", () => {
    for (const points of [
      [10, 10],
      [10, 10, Number.NaN],
      [10, 10, 2],
    ]) {
      const invalid = { ...pen, points: new Float64Array(points) as unknown as number[] };
      const before = structuredClone(invalid);
      expect(() =>
        applySelectionStyleChange([rectangle, invalid], {
          property: "opacity",
          value: 0.5,
        }),
      ).toThrow();
      expect(invalid).toEqual(before);
    }
  });
});
