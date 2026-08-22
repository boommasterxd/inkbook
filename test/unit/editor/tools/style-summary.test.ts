import { describe, expect, it } from "vitest";

import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { createDragElement, createFreehandElement } from "../../../../src/editor/tools/creation";
import {
  summarizeActiveToolStyle,
  summarizeSelectionStyle,
} from "../../../../src/editor/tools/style-summary";

const identity = { id: "123e4567-e89b-42d3-a456-426614174000", createdAt: 0 };

function shape(tool: "rectangle" | "line" | "arrow" | "coordinate-system" | "table"): InkElementV1 {
  const defaults = createBuiltInSettings().toolDefaults;
  return createDragElement({
    identity,
    tool,
    start: { x: 100, y: 100 },
    end: { x: 300, y: 300 },
    defaults,
  });
}

describe("Style summaries", () => {
  it("reports shared and mixed freehand values", () => {
    const defaults = createBuiltInSettings().toolDefaults;
    const pen = createFreehandElement({ identity, tool: "draw", samples: [10, 10, 0.5], defaults });
    const highlighter = createFreehandElement({
      identity,
      tool: "highlighter",
      samples: [20, 20, 0.5],
      defaults,
    });

    expect(summarizeSelectionStyle([pen, { ...pen, id: "other" }])).toMatchObject({
      kind: "stroke",
      color: { type: "theme-text" },
      width: 8,
      opacity: 1,
      pressureEnabled: true,
    });
    expect(summarizeSelectionStyle([pen, highlighter])).toMatchObject({
      kind: "stroke",
      color: "mixed",
      opacity: "mixed",
      pressureEnabled: null,
    });
  });

  it("shows only properties shared by an outline selection", () => {
    expect(summarizeSelectionStyle([shape("rectangle")])).toMatchObject({
      kind: "outline",
      fill: { color: null, opacity: 0.15 },
      arrowNodes: null,
      structural: null,
    });
    expect(summarizeSelectionStyle([shape("line"), shape("rectangle")])).toMatchObject({
      kind: "outline",
      fill: null,
      arrowNodes: null,
      structural: null,
    });
    expect(summarizeSelectionStyle([shape("arrow")])).toMatchObject({
      arrowNodes: { start: "none", end: "arrow" },
    });
  });

  it("includes structural controls only for homogeneous selections", () => {
    expect(summarizeSelectionStyle([shape("coordinate-system")])).toMatchObject({
      structural: { kind: "coordinate-system", dimension: "2d" },
    });
    expect(summarizeSelectionStyle([shape("table")])).toMatchObject({
      structural: { kind: "table", columns: 3 },
    });
    expect(summarizeSelectionStyle([shape("table"), shape("line")])).toMatchObject({
      structural: null,
    });
  });

  it("summarizes active creation tool values without exposing unavailable controls", () => {
    const values = createBuiltInSettings().toolDefaults;
    expect(summarizeActiveToolStyle(values, "select")).toBeNull();
    expect(summarizeActiveToolStyle(values, "eraser")).toEqual({ kind: "eraser", radius: 24 });
    expect(summarizeActiveToolStyle(values, "draw")).toMatchObject({
      kind: "stroke",
      pressureEnabled: true,
    });
    expect(summarizeActiveToolStyle(values, "highlighter")).toMatchObject({
      kind: "stroke",
      pressureEnabled: null,
    });
    expect(summarizeActiveToolStyle(values, "arrow")).toMatchObject({
      kind: "outline",
      fill: null,
      arrowNodes: { start: "none", end: "arrow" },
    });
    expect(summarizeActiveToolStyle(values, "table")).toMatchObject({
      structural: { kind: "table", columns: 3 },
    });
  });

  it("returns no selection summary for empty or incompatible style families", () => {
    const defaults = createBuiltInSettings().toolDefaults;
    const pen = createFreehandElement({ identity, tool: "draw", samples: [10, 10, 0.5], defaults });
    expect(summarizeSelectionStyle([])).toBeNull();
    expect(summarizeSelectionStyle([pen, shape("line")])).toBeNull();
  });
});
