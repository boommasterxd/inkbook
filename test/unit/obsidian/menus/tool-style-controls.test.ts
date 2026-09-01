import { describe, expect, it } from "vitest";

import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import {
  ARROW_NODE_STYLE_OPTIONS,
  createToolStyleControls,
  OUTLINE_STYLE_OPTIONS,
  OUTLINE_WIDTH_STYLE_OPTIONS,
  PEN_WIDTH_STYLE_OPTIONS,
} from "../../../../src/obsidian/menus/tool-style-controls";

describe("tool Style controls", () => {
  it("creates the complete active controls for every tool family", () => {
    const defaults = createBuiltInSettings().toolDefaults;

    expect(createToolStyleControls(defaults, "draw").map(({ id }) => id)).toEqual([
      "color",
      "stroke-width",
      "opacity",
      "pressure-enabled",
    ]);
    expect(createToolStyleControls(defaults, "rectangle").map(({ id }) => id)).toEqual([
      "outline-color",
      "outline-width",
      "outline-style",
      "outline-opacity",
      "fill-color",
      "fill-opacity",
    ]);
    expect(createToolStyleControls(defaults, "arrow").map(({ id }) => id)).toEqual([
      "outline-color",
      "outline-width",
      "outline-style",
      "outline-opacity",
      "arrow-start-node",
      "arrow-end-node",
    ]);
    expect(createToolStyleControls(defaults, "coordinate-system")).toContainEqual(
      expect.objectContaining({ id: "coordinate-dimension" }),
    );
    expect(createToolStyleControls(defaults, "table")).toContainEqual(
      expect.objectContaining({ id: "table-columns" }),
    );
    expect(createToolStyleControls(defaults, "eraser")).toEqual([
      {
        id: "eraser-radius",
        kind: "number",
        label: "Eraser radius",
        max: 64,
        min: 8,
        step: 4,
        value: defaults.eraser.radius,
      },
    ]);
    expect(createToolStyleControls(defaults, "select")).toEqual([
      {
        id: "selection-area",
        kind: "choice",
        label: "Selection area",
        options: [
          { label: "Rectangle", value: "rectangle" },
          { label: "Lasso", value: "lasso" },
        ],
        value: "rectangle",
      },
      {
        id: "selection-inclusion",
        kind: "choice",
        label: "Include elements",
        options: [
          { label: "Fully enclosed", value: "fully-enclosed" },
          { label: "Touched", value: "touched" },
        ],
        value: "touched",
      },
    ]);
  });

  it("exports the canonical choice labels and values for reuse", () => {
    expect(PEN_WIDTH_STYLE_OPTIONS).toEqual([
      { label: "XS", value: "2" },
      { label: "S", value: "4" },
      { label: "M", value: "8" },
      { label: "L", value: "14" },
      { label: "XL", value: "22" },
    ]);
    expect(OUTLINE_WIDTH_STYLE_OPTIONS).toEqual(PEN_WIDTH_STYLE_OPTIONS);
    expect(OUTLINE_STYLE_OPTIONS.map(({ value }) => value)).toEqual(["solid", "dashed", "dotted"]);
    expect(ARROW_NODE_STYLE_OPTIONS.map(({ value }) => value)).toEqual([
      "none",
      "arrow",
      "triangle",
      "diamond",
      "circle",
    ]);
  });
});
