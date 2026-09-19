import { describe, expect, it, vi } from "vitest";

import { calculateElementBounds } from "../../../../../src/domain/geometry/public";
import { createBuiltInSettings } from "../../../../../src/domain/settings/defaults";
import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import type { ToolDefaultsV1 } from "../../../../../src/domain/settings/types";
import type { EditorTool } from "../../../../../src/editor/input";
import {
  CreationPreview,
  type CreationSnapPorts,
  type CreationPreviewRenderer,
} from "../../../../../src/obsidian/embeds/active-editor/creation-preview";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import type { LivePathState } from "../../../../../src/rendering/scene";
import { creationPreviewRenderer } from "../../../../fixtures/obsidian/active-editor";

const OUTLINE = {
  outlineColor: { type: "rgba" as const, value: "#EF4444FF" as const },
  outlineOpacity: 0.35,
  outlineStyle: "dashed" as const,
  outlineWidth: 14 as const,
};

const SEMANTIC_ENDPOINT_TARGET_ID = "00000000-0000-4000-8000-000000000099";

describe("drag creation preview presentation", () => {
  it.each([
    ["line", "dashed", "56 42", "butt"],
    ["coordinate-system", "dotted", "0 35", "round"],
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
        "stroke-width": "14",
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
      "stroke-dasharray": "56 42",
      "stroke-opacity": "0.35",
      "stroke-width": "14",
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
      "stroke-width": "14",
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

describe("drag creation without minimum geometry", () => {
  const tools = [
    "line",
    "arrow",
    "straight-highlighter",
    "rectangle",
    "ellipse",
    "triangle",
    "octagon",
    "parallelogram",
    "diamond",
    "coordinate-system",
    "table",
  ] as const;

  it.each(tools)("starts %s at the pointer and follows sub-unit movement", (tool) => {
    const setLivePath = vi.fn<(path: LivePathState | null) => void>();
    const committed: InkElementV1[] = [];
    const preview = createPreview(
      styledDefaults(),
      tool,
      { setLivePath },
      {
        commitElements: (elements) => committed.push(...elements),
      },
    );
    const initial = setLivePath.mock.lastCall?.[0];
    expect(initial?.parts).toHaveLength(1);
    expect(initial?.parts[0]?.d).toMatch(/^(?:M10 20L10 20)+$/);
    preview.update({ pointerId: 1, pointerType: "pen", x: 10.006, y: 20.004 });
    const moved = setLivePath.mock.lastCall?.[0];
    expect(moved?.parts[0]?.d).not.toBe(initial?.parts[0]?.d);
    expect(preview.commit()).toBe(true);
    expect(committed).toHaveLength(1);
    const bounds = calculateElementBounds(committed[0]!);
    // Geometry stays within the pen-width footprint, including arrow decorations.
    expect(bounds.maxX - bounds.minX).toBeLessThan(21);
    expect(bounds.maxY - bounds.minY).toBeLessThan(21);
    expect(setLivePath).toHaveBeenLastCalledWith(null);
  });

  it("shows the snapped start cross immediately while allowing coincident endpoints", () => {
    const committed: InkElementV1[] = [];
    const snap = endpointSnapPorts();
    const setSnapMarkerPath = vi.fn<(path: string | null) => void>();
    const preview = createPreview(
      styledDefaults(),
      "line",
      { setSnapMarkerPath },
      {
        commitElements: (elements) => committed.push(...elements),
        snap: {
          ...snap,
          targets: {
            get: () => ({
              rank: 0,
              anchors: [
                {
                  anchor: { endpoint: "end", kind: "linear-endpoint" },
                  order: 0,
                  point: { x: 10, y: 20 },
                },
              ],
            }),
          },
        },
      },
    );
    expect(setSnapMarkerPath.mock.lastCall?.[0]).toContain("M -2 20 L 22 20");
    preview.update({ pointerId: 1, pointerType: "pen", x: 12, y: 21 });
    expect(setSnapMarkerPath.mock.lastCall?.[0]).toContain("M -2 20 L 22 20");
    preview.commit();
    expect(committed[0]).toMatchObject({
      start: { x: 10, y: 20 },
      end: { x: 10, y: 20 },
      startConnection: { targetId: SEMANTIC_ENDPOINT_TARGET_ID },
      endConnection: { targetId: SEMANTIC_ENDPOINT_TARGET_ID },
    });
  });
});

describe("angular snap activation", () => {
  it.each([0.5, 1, 4])(
    "delays line and arrow angular guides until eight screen pixels at zoom %s",
    (zoom) => {
      for (const tool of ["line", "arrow"] as const) {
        const { preview, committed, setSnapMarkerPath } = linearCreationPreview(
          tool,
          creationSnapPorts(zoom),
        );
        expect(setSnapMarkerPath).toHaveBeenLastCalledWith(null);
        for (const screenLength of [2, 7.9, 8, 16, 2, 0]) {
          preview.update({ pointerId: 1, pointerType: "pen", x: 10 + screenLength / zoom, y: 20 });
          const guide = setSnapMarkerPath.mock.lastCall?.[0];
          if (screenLength < 8) expect(guide).toBeNull();
          else expect(guide).toContain(" L ");
        }
        preview.update({ pointerId: 1, pointerType: "pen", x: 10 + 2 / zoom, y: 20 + 1 / zoom });
        expect(setSnapMarkerPath).toHaveBeenLastCalledWith(null);
        preview.commit();
        expect(committed[0]).toMatchObject({ end: { x: 10 + 2 / zoom, y: 20 + 1 / zoom } });
      }
    },
  );
});

describe("drag creation preview snapping", () => {
  it("keeps line direction free when angle snapping is disabled", () => {
    const committed = commitLinearPreview("line", {
      ...creationSnapPorts(1),
      angles: false,
    });

    expect(committed).toMatchObject({ end: { x: 110, y: 24 }, kind: "line" });
  });

  it("does not attach new endpoints when connection snapping is disabled", () => {
    const committed = commitLinearPreview("arrow", {
      ...endpointSnapPorts(),
      connections: false,
    });

    expect(committed).toMatchObject({ endConnection: null, kind: "arrow" });
  });

  it("applies a changed temporary snapping override on the next pointer frame", () => {
    let snappingEnabled = true;
    const { committed, preview, setSnapMarkerPath } = linearCreationPreview("arrow", {
      ...endpointSnapPorts(),
      angles: false,
      connections: () => snappingEnabled,
    });

    preview.update({ pointerId: 1, pointerType: "mouse", x: 110, y: 24 });
    expect(setSnapMarkerPath.mock.lastCall?.[0]).not.toBeNull();

    snappingEnabled = false;
    preview.update({ pointerId: 1, pointerType: "mouse", x: 110, y: 24 });
    expect(setSnapMarkerPath).toHaveBeenLastCalledWith(null);

    snappingEnabled = true;
    preview.update({ pointerId: 1, pointerType: "mouse", x: 110, y: 24 });
    preview.commit();
    expect(committed[0]).toMatchObject({
      endConnection: { targetId: SEMANTIC_ENDPOINT_TARGET_ID },
      kind: "arrow",
    });
  });

  it.each(["line", "arrow"] as const)(
    "snaps a newly created %s to a right angle and renders its angular guide",
    (tool) => {
      const { committed, preview, setSnapMarkerPath } = linearCreationPreview(
        tool,
        creationSnapPorts(1),
      );

      preview.update({ pointerId: 1, pointerType: "mouse", x: 110, y: 24 });

      expect(setSnapMarkerPath.mock.lastCall?.[0]).toContain("M -14 20 L 134.07999999999998 20");
      preview.commit();
      expect(committed[0]).toMatchObject({
        end: { x: 110.08, y: 20 },
        kind: tool,
        start: { x: 10, y: 20 },
      });
    },
  );

  it.each(["line", "arrow"] as const)(
    "keeps a newly created %s free at higher zoom when it is outside the angular snap range",
    (tool) => {
      const committed = commitLinearPreview(tool, creationSnapPorts(4));

      expect(committed).toMatchObject({ end: { x: 110, y: 24 }, kind: tool });
    },
  );

  it.each(["line", "arrow"] as const)(
    "prioritizes a semantic endpoint anchor over the angular snap when creating an %s",
    (tool) => {
      const committed = commitLinearPreview(tool, endpointSnapPorts());

      expect(committed).toMatchObject({
        end: { x: 110, y: 24 },
        endConnection: {
          anchor: { endpoint: "end", kind: "linear-endpoint" },
          targetId: SEMANTIC_ENDPOINT_TARGET_ID,
        },
        kind: tool,
      });
    },
  );
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
    expect(call[0].tail.geometry).toEqual([expect.objectContaining({ paint: "stroke" })]);
    expect(call[1].pressureEnabled).toBe(false);
    expect(call[2]).toBe(tool);
  });
});

describe("creation preview frame sample policy", () => {
  it.each([
    ["draw", "preserve"],
    ["highlighter", "preserve"],
    ["line", "latest"],
    ["straight-highlighter", "latest"],
    ["rectangle", "latest"],
    ["coordinate-system", "latest"],
    ["table", "latest"],
  ] as const)("uses %s samples in %s mode", (tool, mode) => {
    const preview = createPreview(styledDefaults(), tool, {});

    expect(preview.frameSampleMode).toBe(mode);
  });
});

function styledDefaults(): ToolDefaultsV1 {
  return structuredClone(createBuiltInSettings().toolDefaults);
}

function createPreview(
  defaults: ToolDefaultsV1,
  tool: EditorTool,
  renderer: Partial<CreationPreviewRenderer>,
  options: {
    readonly commitElements?: (elements: readonly InkElementV1[]) => void;
    readonly snap?: CreationSnapPorts;
  } = {},
): CreationPreview {
  return new CreationPreview({
    defaults,
    history: new ActiveEditorHistory({
      commitBandOrder: vi.fn(),
      commitElements: options.commitElements ?? vi.fn(),
      commitPage: vi.fn(),
      removeElements: vi.fn(),
      replaceElements: vi.fn(),
    }),
    identity: { createdAt: 1, id: "00000000-0000-4000-8000-000000000001" },
    renderer: creationPreviewRenderer(renderer),
    ...(options.snap === undefined ? {} : { snap: options.snap }),
    start: {
      additive: false,
      kind: "tool-gesture",
      pointer: { pointerId: 1, pointerType: "mouse", x: 10, y: 20 },
      tool,
    },
  });
}

function linearCreationPreview(tool: "arrow" | "line", snap: CreationSnapPorts) {
  const committed: InkElementV1[] = [];
  const setSnapMarkerPath = vi.fn<(path: string | null) => void>();
  const preview = createPreview(
    styledDefaults(),
    tool,
    { setSnapMarkerPath },
    {
      commitElements: (elements) => committed.push(...elements),
      snap,
    },
  );
  return { committed, preview, setSnapMarkerPath };
}

function commitLinearPreview(tool: "arrow" | "line", snap: CreationSnapPorts): InkElementV1 {
  const { committed, preview } = linearCreationPreview(tool, snap);
  preview.update({ pointerId: 1, pointerType: "mouse", x: 110, y: 24 });
  preview.commit();
  const element = committed[0];
  if (element === undefined) throw new Error("Expected a committed linear element.");
  return element;
}

function creationSnapPorts(zoom: number): CreationSnapPorts {
  return {
    pageToScreen: (point) => point,
    spatial: { query: () => undefined },
    targets: { get: () => null },
    zoom,
  };
}

function endpointSnapPorts(zoom = 1): CreationSnapPorts {
  return {
    pageToScreen: (point) => point,
    spatial: { query: (_bounds, sink) => sink.add(SEMANTIC_ENDPOINT_TARGET_ID) },
    targets: {
      get: (id) =>
        id === SEMANTIC_ENDPOINT_TARGET_ID
          ? {
              anchors: [
                {
                  anchor: { endpoint: "end", kind: "linear-endpoint" },
                  order: 0,
                  point: { x: 110, y: 24 },
                },
              ],
              rank: 0,
            }
          : null,
    },
    zoom,
  };
}

function renderPreview(tool: EditorTool, defaults: ToolDefaultsV1): LivePathState {
  const setLivePath = vi.fn<(path: LivePathState | null) => void>();
  const preview = createPreview(defaults, tool, { setLivePath });
  preview.update({ pointerId: 1, pointerType: "mouse", x: 120, y: 100 });
  const state = setLivePath.mock.lastCall?.[0];
  if (state === null || state === undefined) throw new Error("Expected a live drag preview.");
  return state;
}
