import { describe, expect, it } from "vitest";

import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { createDragElement, createFreehandElement } from "../../../../src/editor/tools/public";
import {
  createActiveEditorStyleControls,
  createActiveEditorStyleIcon,
  createSelectionStyleReplacement,
  updateSessionToolDefaults,
} from "../../../../src/obsidian/embeds/active-editor/controller-styles";
import { OUTLINE_WIDTH_STYLE_OPTIONS } from "../../../../src/obsidian/menus/tool-style-controls";

function identity(id: string) {
  return { createdAt: 0, id };
}

function rectangle(id: string): Extract<InkElementV1, { kind: "rectangle" }> {
  const element = createDragElement({
    defaults: createBuiltInSettings().toolDefaults,
    end: { x: 200, y: 200 },
    identity: identity(id),
    start: { x: 100, y: 100 },
    tool: "rectangle",
  });
  if (element.kind !== "rectangle") throw new TypeError("Expected a rectangle fixture.");
  return element;
}

function controlIds(tool: Parameters<typeof createActiveEditorStyleControls>[0]["tool"]) {
  return createActiveEditorStyleControls({
    defaults: createBuiltInSettings().toolDefaults,
    selection: [],
    tool,
  }).map(({ id }) => id);
}

describe("active editor Style controls", () => {
  it("exposes every property supported by each active tool family", () => {
    expect(controlIds("draw")).toEqual(["color", "stroke-width", "opacity", "pressure-enabled"]);
    expect(controlIds("highlighter")).toEqual(["color", "stroke-width", "opacity"]);
    expect(controlIds("rectangle")).toEqual([
      "outline-color",
      "outline-width",
      "outline-style",
      "outline-opacity",
      "fill-color",
      "fill-opacity",
    ]);
    expect(controlIds("arrow")).toEqual([
      "outline-color",
      "outline-width",
      "outline-style",
      "outline-opacity",
      "arrow-start-node",
      "arrow-end-node",
    ]);
    expect(controlIds("coordinate-system")).toContain("coordinate-dimension");
    expect(controlIds("table")).toContain("table-columns");
    expect(controlIds("eraser")).toEqual(["eraser-radius"]);
    expect(controlIds("select")).toEqual([]);
  });

  it("offers the complete XS through XL width scale for strokes and outlines", () => {
    const defaults = createBuiltInSettings().toolDefaults;
    const stroke = createActiveEditorStyleControls({ defaults, selection: [], tool: "draw" });
    const outline = createActiveEditorStyleControls({
      defaults,
      selection: [],
      tool: "rectangle",
    });

    const strokeControl = stroke.find(({ id }) => id === "stroke-width");
    expect(strokeControl).toMatchObject({ kind: "choice" });
    if (strokeControl?.kind !== "choice") throw new TypeError("Expected a stroke-width choice.");
    expect(strokeControl.options.map(({ label }) => label)).toEqual(["XS", "S", "M", "L", "XL"]);
    expect(strokeControl.options.map(({ value }) => value)).toEqual(["2", "4", "8", "14", "22"]);
    expect(outline.find(({ id }) => id === "outline-width")).toMatchObject({
      options: OUTLINE_WIDTH_STYLE_OPTIONS,
    });
  });
});

describe("active editor Style icon and selection controls", () => {
  it("derives the toolbar palette from the active tool defaults", () => {
    const defaults = createBuiltInSettings().toolDefaults;
    defaults.pen.color = { type: "rgba", value: "#EF4444FF" };
    defaults.shapes.rectangle = {
      ...defaults.shapes.rectangle,
      fillColor: { type: "rgba", value: "#8B5CF6FF" },
      fillOpacity: 0.3,
      outlineColor: { type: "rgba", value: "#F97316FF" },
      outlineStyle: "dashed",
    };

    expect(createActiveEditorStyleIcon(defaults, "draw")).toEqual({
      fillColor: null,
      fillOpacity: 0,
      outlineColor: { type: "rgba", value: "#EF4444FF" },
      outlineStyle: "solid",
    });
    expect(createActiveEditorStyleIcon(defaults, "rectangle")).toEqual({
      fillColor: { type: "rgba", value: "#8B5CF6FF" },
      fillOpacity: 0.3,
      outlineColor: { type: "rgba", value: "#F97316FF" },
      outlineStyle: "dashed",
    });
    expect(createActiveEditorStyleIcon(defaults, "select")).toEqual({
      fillColor: null,
      fillOpacity: 0,
      outlineColor: null,
      outlineStyle: "solid",
    });
  });

  it("reports mixed shared selection values and hides incompatible properties", () => {
    const first = rectangle("123e4567-e89b-42d3-a456-426614174001");
    const second = {
      ...rectangle("123e4567-e89b-42d3-a456-426614174002"),
      style: { ...first.style, fillColor: { type: "rgba", value: "#EF4444FF" }, outlineWidth: 8 },
    } satisfies InkElementV1;
    const controls = createActiveEditorStyleControls({
      defaults: createBuiltInSettings().toolDefaults,
      selection: [first, second],
      tool: "draw",
    });

    expect(controls.find(({ id }) => id === "outline-width")).toMatchObject({
      mixed: true,
      value: null,
    });
    expect(controls.find(({ id }) => id === "fill-color")).toMatchObject({
      mixed: true,
      value: null,
    });
    expect(controls.some(({ id }) => id === "pressure-enabled")).toBe(false);
  });
});

describe("active editor Style changes", () => {
  it("creates an atomic replacement pair without changing selected elements", () => {
    const first = rectangle("123e4567-e89b-42d3-a456-426614174003");
    const second = rectangle("123e4567-e89b-42d3-a456-426614174004");
    const replacement = createSelectionStyleReplacement(
      [first, second],
      "outline-color",
      "#3B82F6FF",
    );

    expect(replacement?.previous).toEqual([first, second]);
    expect(replacement?.replacements).toHaveLength(2);
    expect(replacement?.replacements[0]?.style).toMatchObject({
      outlineColor: { type: "rgba", value: "#3B82F6FF" },
    });
    expect(first.style).toMatchObject({ outlineColor: { type: "theme-text" } });
    expect(
      createSelectionStyleReplacement(replacement?.replacements ?? [], "outline-width", "2"),
    ).toBeNull();
  });

  it("updates only cloned session defaults and validates callback values", () => {
    const vaultDefaults = createBuiltInSettings().toolDefaults;
    const sessionDefaults = updateSessionToolDefaults(
      vaultDefaults,
      "arrow",
      "arrow-start-node",
      "circle",
    );

    expect(sessionDefaults).not.toBe(vaultDefaults);
    expect(sessionDefaults.arrow.startNode).toBe("circle");
    expect(vaultDefaults.arrow.startNode).toBe("none");
    expect(updateSessionToolDefaults(sessionDefaults, "arrow", "arrow-start-node", "circle")).toBe(
      sessionDefaults,
    );
    expect(() => updateSessionToolDefaults(sessionDefaults, "table", "table-columns", 13)).toThrow(
      RangeError,
    );
    expect(() => updateSessionToolDefaults(sessionDefaults, "draw", "opacity", "invalid")).toThrow(
      TypeError,
    );
  });

  it("accepts the advertised XS outline width", () => {
    const defaults = createBuiltInSettings().toolDefaults;
    const updated = updateSessionToolDefaults(defaults, "rectangle", "outline-width", "1");

    expect(updated.shapes.rectangle.outlineWidth).toBe(1);
    expect(defaults.shapes.rectangle.outlineWidth).not.toBe(1);
  });

  it("marks mixed structural values and applies table column changes", () => {
    const defaults = createBuiltInSettings().toolDefaults;
    const first = createDragElement({
      defaults,
      end: { x: 400, y: 300 },
      identity: identity("123e4567-e89b-42d3-a456-426614174005"),
      start: { x: 100, y: 100 },
      tool: "table",
    });
    const changed = createSelectionStyleReplacement([first], "table-columns", 4);
    const second = changed?.replacements[0];
    expect(second?.kind).toBe("table");

    const controls = createActiveEditorStyleControls({
      defaults,
      selection: second === undefined ? [first] : [first, second],
      tool: "table",
    });
    expect(controls.find(({ id }) => id === "table-columns")).toMatchObject({
      mixed: true,
      value: null,
    });
  });

  it("uses pen selection values instead of the active tool defaults", () => {
    const defaults = createBuiltInSettings().toolDefaults;
    const pen = createFreehandElement({
      defaults,
      identity: identity("123e4567-e89b-42d3-a456-426614174006"),
      samples: [10, 10, 0.5, 20, 20, 0.75],
      tool: "draw",
    });
    const controls = createActiveEditorStyleControls({
      defaults,
      selection: [pen],
      tool: "eraser",
    });

    expect(controls.map(({ id }) => id)).toEqual(["color", "stroke-width", "opacity"]);
    expect(controls.some(({ id }) => id === "eraser-radius")).toBe(false);
  });
});
