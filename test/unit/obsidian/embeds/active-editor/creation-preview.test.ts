import { describe, expect, it, vi } from "vitest";

import { createBuiltInSettings } from "../../../../../src/domain/settings/defaults";
import type { ToolDefaultsV1 } from "../../../../../src/domain/settings/types";
import type { EditorTool } from "../../../../../src/editor/input";
import {
  CreationPreview,
  type CreationPreviewRenderer,
} from "../../../../../src/obsidian/embeds/active-editor/creation-preview";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import type { LivePathState } from "../../../../../src/rendering/scene";
import { creationPreviewRenderer } from "../../../../fixtures/obsidian/active-editor";

const OUTLINE = {
  outlineColor: { type: "rgba" as const, value: "#EF4444FF" as const },
  outlineOpacity: 0.35,
  outlineStyle: "dashed" as const,
  outlineWidth: 12 as const,
};

describe("drag creation preview presentation", () => {
  it.each([
    ["line", "dashed", "48 36", "butt"],
    ["coordinate-system", "dotted", "0 30", "round"],
    ["table", "solid", null, "butt"],
  ] as const)(
    "uses the active %s outline color, width, opacity, and %s style",
    (tool, outlineStyle, dash, lineCap) => {
      const defaults = styledDefaults();
      defaults.shapes[tool] = { ...OUTLINE, outlineStyle };

      const state = renderPreview(tool, defaults);

      expect(state.parts).toHaveLength(1);
      expect(state.parts[0]?.presentation).toMatchObject({
        fill: "none",
        stroke: "#EF4444FF",
        "stroke-dasharray": dash,
        "stroke-linecap": lineCap,
        "stroke-opacity": "0.35",
        "stroke-width": "12",
      });
    },
  );

  it("uses both configured fill and outline presentation for a closed shape", () => {
    const defaults = styledDefaults();
    defaults.shapes.rectangle = {
      ...OUTLINE,
      fillColor: { type: "rgba", value: "#3B82F6FF" },
      fillOpacity: 0.25,
    };

    const state = renderPreview("rectangle", defaults);

    expect(state.parts).toHaveLength(1);
    expect(state.parts[0]?.presentation).toMatchObject({
      fill: "#3B82F6FF",
      "fill-opacity": "0.25",
      stroke: "#EF4444FF",
      "stroke-dasharray": "48 36",
      "stroke-opacity": "0.35",
      "stroke-width": "12",
    });
  });

  it("keeps the arrow body stroked while rendering filled nodes as a separate part", () => {
    const defaults = styledDefaults();
    defaults.shapes.arrow = { ...OUTLINE };
    defaults.arrow = { endNode: "diamond", startNode: "triangle" };

    const state = renderPreview("arrow", defaults);

    expect(state.parts).toHaveLength(2);
    expect(state.parts[0]?.presentation).toMatchObject({
      fill: "none",
      stroke: "#EF4444FF",
      "stroke-width": "12",
    });
    expect(state.parts[1]?.presentation).toMatchObject({
      fill: "#EF4444FF",
      "fill-opacity": "0.35",
      stroke: "none",
      "stroke-width": null,
    });
    expect(state.parts[0]?.d).not.toBe(state.parts[1]?.d);
  });

  it("renders a straight highlighter at 2.5 times its selected base width", () => {
    const defaults = styledDefaults();
    defaults.straightHighlighter = {
      color: { type: "rgba", value: "#EAB308FF" },
      opacity: 0.4,
      width: 14,
    };

    const state = renderPreview("straight-highlighter", defaults);

    expect(state.band).toBe("highlight");
    expect(state.parts[0]?.presentation).toMatchObject({
      fill: "none",
      stroke: "#EAB308FF",
      "stroke-opacity": "0.4",
      "stroke-width": "35",
    });
  });
});

describe("freehand creation preview presentation", () => {
  it.each([
    ["pen", "draw"],
    ["highlighter", "highlighter"],
  ] as const)("forwards the %s stroke tool to the live renderer", (tool, startTool) => {
    const defaults = styledDefaults();
    defaults.pen.pressureEnabled = false;
    const updateLiveStroke = vi.fn<CreationPreviewRenderer["updateLiveStroke"]>();

    createPreview(defaults, startTool, { updateLiveStroke });

    const call = updateLiveStroke.mock.lastCall;
    if (call === undefined) throw new Error("Expected a live stroke update.");
    expect(call[0].tail.geometry.paint).toBe("stroke");
    expect(call[1].pressureEnabled).toBe(false);
    expect(call[2]).toBe(tool);
  });
});

function styledDefaults(): ToolDefaultsV1 {
  return structuredClone(createBuiltInSettings().toolDefaults);
}

function createPreview(
  defaults: ToolDefaultsV1,
  tool: EditorTool,
  renderer: Partial<CreationPreviewRenderer>,
): CreationPreview {
  return new CreationPreview({
    defaults,
    history: new ActiveEditorHistory({
      commitBandOrder: vi.fn(),
      commitElements: vi.fn(),
      commitPage: vi.fn(),
      removeElements: vi.fn(),
      replaceElements: vi.fn(),
    }),
    identity: { createdAt: 1, id: "00000000-0000-4000-8000-000000000001" },
    renderer: creationPreviewRenderer(renderer),
    start: {
      additive: false,
      kind: "tool-gesture",
      pointer: { pointerId: 1, pointerType: "mouse", x: 10, y: 20 },
      tool,
    },
  });
}

function renderPreview(tool: EditorTool, defaults: ToolDefaultsV1): LivePathState {
  const setLivePath = vi.fn<(path: LivePathState | null) => void>();
  const preview = createPreview(defaults, tool, { setLivePath });
  preview.update({ pointerId: 1, pointerType: "mouse", x: 120, y: 100 });
  const state = setLivePath.mock.lastCall?.[0];
  if (state === null || state === undefined) throw new Error("Expected a live drag preview.");
  return state;
}
