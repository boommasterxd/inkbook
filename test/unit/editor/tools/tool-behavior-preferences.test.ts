import { describe, expect, it } from "vitest";

import { createBuiltInSettings } from "../../../../src/domain/settings";
import { createFreehandElement } from "../../../../src/editor/tools/creation";
import {
  applySelectionStyleChange,
  applyToolStyleChange,
  type StyleChange,
} from "../../../../src/editor/tools/style-change";
import { summarizeActiveToolStyle } from "../../../../src/editor/tools/style-summary";

describe("creation behavior Style preferences", () => {
  it.each([
    ["draw", "hold-to-shape-enabled", "pen", "holdToShapeEnabled"],
    ["line", "snapping-enabled", "line", "snappingEnabled"],
    ["arrow", "snapping-enabled", "arrow", "snappingEnabled"],
  ] as const)(
    "updates %s independently and preserves no-op identity",
    (tool, property, key, field) => {
      const values = createBuiltInSettings().toolDefaults;
      const change = { property, value: false };
      const result = applyToolStyleChange(values, tool, change);
      expect(result.changed).toBe(true);
      expect(result.toolValues[key]).toHaveProperty(field, false);
      expect(values[key]).toHaveProperty(field, true);
      expect(result.toolValues.pen.pressureEnabled).toBe(true);
      expect(applyToolStyleChange(result.toolValues, tool, change)).toEqual({
        toolValues: result.toolValues,
        changed: false,
      });
      expect(applyToolStyleChange(result.toolValues, tool, change).toolValues).toBe(
        result.toolValues,
      );
      expect(summarizeActiveToolStyle(result.toolValues, tool)).toHaveProperty(field, false);
    },
  );

  it("rejects unsupported tools, non-booleans and existing selections", () => {
    const values = createBuiltInSettings().toolDefaults;
    const pen = createFreehandElement({
      identity: { id: "123e4567-e89b-42d3-a456-426614174000", createdAt: 0 },
      tool: "draw",
      samples: [10, 10, 0.5],
      defaults: values,
    });
    for (const property of ["hold-to-shape-enabled", "snapping-enabled"] as const) {
      const change = { property, value: false };
      expect(() => applyToolStyleChange(values, "highlighter", change)).toThrow(/does not apply/);
      expect(() => applySelectionStyleChange([pen], change)).toThrow(/not shared/);
      const tool = property === "hold-to-shape-enabled" ? "draw" : "line";
      expect(() =>
        applyToolStyleChange(values, tool, { property, value: "false" } as unknown as StyleChange),
      ).toThrow(/boolean/);
    }
    expect(summarizeActiveToolStyle(values, "straight-highlighter")).toHaveProperty(
      "holdToShapeEnabled",
      null,
    );
    expect(summarizeActiveToolStyle(values, "rectangle")).toHaveProperty("snappingEnabled", null);
  });
});
