import { describe, expect, it } from "vitest";

import type {
  BoxShapeElementV1,
  CoordinateSystemElementV1,
  TableElementV1,
} from "../../../../src/domain/schema/public";
import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { createDragElement, createFreehandElement } from "../../../../src/editor/tools/creation";
import {
  applySelectionStyleChange,
  applyToolStyleChange,
} from "../../../../src/editor/tools/style-change";

const identity = { id: "123e4567-e89b-42d3-a456-426614174000", createdAt: 0 };

describe("selection paint Style changes", () => {
  it("applies shared selection paint properties immutably", () => {
    const defaults = createBuiltInSettings().toolDefaults;
    const pen = createFreehandElement({ identity, tool: "draw", samples: [10, 10, 0.5], defaults });
    const result = applySelectionStyleChange([pen], { property: "opacity", value: 0.5 });

    expect(result.changed).toBe(true);
    expect(result.elements[0]?.style).toMatchObject({ opacity: 0.5 });
    expect(pen.style.opacity).toBe(1);
  });

  it("canonicalizes selection opacity when committing a style change", () => {
    const defaults = createBuiltInSettings().toolDefaults;
    const pen = createFreehandElement({ identity, tool: "draw", samples: [10, 10, 0.5], defaults });

    const result = applySelectionStyleChange([pen], { property: "opacity", value: 0.12345 });

    expect(result.elements[0]?.style).toMatchObject({ opacity: 0.1235 });
  });

  it("returns the original selection for an accepted no-op", () => {
    const defaults = createBuiltInSettings().toolDefaults;
    const line = createDragElement({
      identity,
      tool: "line",
      start: { x: 10, y: 10 },
      end: { x: 100, y: 10 },
      defaults,
    });
    const selection = [line];
    const result = applySelectionStyleChange(selection, { property: "outline-width", value: 4 });

    expect(result).toEqual({ elements: selection, changed: false });
    expect(result.elements).toBe(selection);
  });

  it("rejects properties that are not shared by every selected element", () => {
    const defaults = createBuiltInSettings().toolDefaults;
    const rectangle = createDragElement({
      identity,
      tool: "rectangle",
      start: { x: 10, y: 10 },
      end: { x: 100, y: 100 },
      defaults,
    });
    const line = createDragElement({
      identity,
      tool: "line",
      start: { x: 10, y: 10 },
      end: { x: 100, y: 10 },
      defaults,
    });

    expect(() =>
      applySelectionStyleChange([rectangle, line], {
        property: "fill-opacity",
        value: 0.5,
      }),
    ).toThrow(/not shared/);
  });
});

describe("selection paint property families", () => {
  it("applies every compatible paint property to its element family", () => {
    const defaults = createBuiltInSettings().toolDefaults;
    const pen = createFreehandElement({
      identity,
      tool: "draw",
      samples: [10, 10, 0.5],
      defaults,
    });
    const line = createDragElement({
      identity: { ...identity, id: "123e4567-e89b-42d3-a456-426614174001" },
      tool: "line",
      start: { x: 10, y: 10 },
      end: { x: 100, y: 10 },
      defaults,
    });
    const rectangle = createDragElement({
      identity: { ...identity, id: "123e4567-e89b-42d3-a456-426614174002" },
      tool: "rectangle",
      start: { x: 10, y: 10 },
      end: { x: 100, y: 100 },
      defaults,
    });

    const changedPen = applySelectionStyleChange([pen], {
      property: "color",
      value: { type: "rgba", value: "#FF00AAFF" },
    });
    expect(changedPen.elements[0]?.style).toMatchObject({
      color: { type: "rgba", value: "#FF00AAFF" },
    });
    expect(
      applySelectionStyleChange([pen], { property: "stroke-width", value: 2 }).elements[0]?.style,
    ).toMatchObject({ width: 2 });

    const changedLine = applySelectionStyleChange([line], {
      property: "outline-color",
      value: { type: "rgba", value: "#00AAFFFF" },
    });
    expect(changedLine.elements[0]?.style).toMatchObject({
      outlineColor: { type: "rgba", value: "#00AAFFFF" },
    });
    expect(
      applySelectionStyleChange([line], { property: "outline-style", value: "dashed" }).elements[0]
        ?.style,
    ).toMatchObject({ outlineStyle: "dashed" });
    expect(
      applySelectionStyleChange([line], { property: "outline-opacity", value: 0.25 }).elements[0]
        ?.style,
    ).toMatchObject({ outlineOpacity: 0.25 });

    const changedRectangle = applySelectionStyleChange([rectangle], {
      property: "fill-color",
      value: { type: "theme-text" },
    });
    expect(changedRectangle.elements[0]?.style).toMatchObject({
      fillColor: { type: "theme-text" },
    });
    expect(
      applySelectionStyleChange([rectangle], { property: "fill-opacity", value: 0.75 }).elements[0]
        ?.style,
    ).toMatchObject({ fillOpacity: 0.75 });
  });
});

describe("selection paint compatibility", () => {
  it("rejects empty and element-incompatible selections", () => {
    const defaults = createBuiltInSettings().toolDefaults;
    const pen = createFreehandElement({ identity, tool: "draw", samples: [10, 10, 0.5], defaults });
    const arrow = createDragElement({
      identity: { ...identity, id: "123e4567-e89b-42d3-a456-426614174003" },
      tool: "arrow",
      start: { x: 10, y: 10 },
      end: { x: 100, y: 10 },
      defaults,
    });

    expect(() => applySelectionStyleChange([], { property: "opacity", value: 0.5 })).toThrow(
      /non-empty/,
    );
    expect(() => applySelectionStyleChange([pen], { property: "outline-width", value: 2 })).toThrow(
      /not shared/,
    );
    expect(() =>
      applySelectionStyleChange([pen], { property: "pressure-enabled", value: false }),
    ).toThrow(/not shared/);
    expect(() =>
      applySelectionStyleChange([pen], { property: "eraser-radius", value: 24 }),
    ).toThrow(/not shared/);
    expect(() =>
      applySelectionStyleChange([arrow], { property: "fill-opacity", value: 0.5 }),
    ).toThrow(/not shared/);
    expect(() =>
      applySelectionStyleChange([rectangleForStyleTest(defaults)], {
        property: "arrow-end-node",
        value: "circle",
      }),
    ).toThrow(/not shared/);
  });

  it("changes arrow endpoints and canonicalizes colors and opacities", () => {
    const defaults = createBuiltInSettings().toolDefaults;
    const arrow = createDragElement({
      identity,
      tool: "arrow",
      start: { x: 10, y: 10 },
      end: { x: 100, y: 10 },
      defaults,
    });
    const changed = applySelectionStyleChange([arrow], {
      property: "arrow-start-node",
      value: "circle",
    });
    expect(changed.elements[0]).toMatchObject({ startNode: "circle" });
    const endChanged = applySelectionStyleChange(changed.elements, {
      property: "arrow-end-node",
      value: "diamond",
    });
    expect(endChanged.elements[0]).toMatchObject({ endNode: "diamond" });

    const rectangle = rectangleForStyleTest(defaults);
    const transparent = applySelectionStyleChange([rectangle], {
      property: "fill-color",
      value: null,
    });
    expect(transparent.elements[0]?.style).toMatchObject({ fillColor: null });
    const opacity = applySelectionStyleChange([rectangle], {
      property: "fill-opacity",
      value: 0.12345,
    });
    expect(opacity.elements[0]?.style).toMatchObject({ fillOpacity: 0.1235 });
    expect(() =>
      applySelectionStyleChange([rectangle], {
        property: "outline-color",
        value: { type: "rgba", value: "invalid" } as never,
      }),
    ).toThrow(/canonical RGBA/);
  });
});

describe("structural Style changes", () => {
  it("changes coordinate dimensionality without disturbing existing axes", () => {
    const defaults = createBuiltInSettings().toolDefaults;
    const system = createDragElement({
      identity,
      tool: "coordinate-system",
      start: { x: 200, y: 200 },
      end: { x: 300, y: 100 },
      defaults,
    }) as CoordinateSystemElementV1;
    const result = applySelectionStyleChange([system], {
      property: "coordinate-dimension",
      value: "3d",
    });
    const changed = result.elements[0] as CoordinateSystemElementV1;

    expect(changed.dimension).toBe("3d");
    expect(changed.axes).toEqual([
      { x: 300, y: 200 },
      { x: 200, y: 100 },
      { x: 150, y: 250 },
    ]);
  });

  it("preserves table geometry while adding and removing rotated local-right columns", () => {
    const defaults = createBuiltInSettings().toolDefaults;
    const original = createDragElement({
      identity,
      tool: "table",
      start: { x: 100, y: 100 },
      end: { x: 400, y: 300 },
      defaults,
    }) as TableElementV1;
    const table = { ...original, rotation: 90 };
    const result = applySelectionStyleChange([table], { property: "table-columns", value: 4 });
    const changed = result.elements[0] as TableElementV1;

    expect(changed).toMatchObject({
      columns: 4,
      columnWidth: 150,
      x: -50,
      y: 250,
      pivot: { x: 250, y: 350 },
      rotation: 90,
    });
    expect(changed.height).toBe(table.height);
    expect(changed.headerHeight).toBe(table.headerHeight);

    const minimumResult = applySelectionStyleChange([changed], {
      property: "table-columns",
      value: 1,
    });
    const minimum = minimumResult.elements[0] as TableElementV1;
    expect(minimum).toMatchObject({
      columns: 1,
      columnWidth: 150,
      x: 175,
      y: 25,
      pivot: { x: 250, y: 125 },
      rotation: 90,
    });
    expect(minimum.height).toBe(table.height);
    expect(minimum.headerHeight).toBe(table.headerHeight);

    const negativeRotation = { ...original, rotation: -179.999 };
    const negativeRotationResult = applySelectionStyleChange([negativeRotation], {
      property: "table-columns",
      value: 4,
    });
    expect(negativeRotationResult.elements[0]?.rotation).toBe(-179.999);
  });
});

describe("active tool Style changes", () => {
  it("updates Select area and inclusion defaults independently", () => {
    const values = createBuiltInSettings().toolDefaults;
    const area = applyToolStyleChange(values, "select", {
      property: "selection-area",
      value: "lasso",
    });
    const inclusion = applyToolStyleChange(area.toolValues, "select", {
      property: "selection-inclusion",
      value: "fully-enclosed",
    });

    expect(inclusion.toolValues.select).toEqual({
      area: "lasso",
      inclusion: "fully-enclosed",
    });
    expect(values.select).toEqual({ area: "rectangle", inclusion: "touched" });
    expect(() =>
      applySelectionStyleChange([], { property: "selection-area", value: "lasso" }),
    ).toThrow(/non-empty selection/);
  });

  it("updates active tool values independently from vault defaults", () => {
    const values = createBuiltInSettings().toolDefaults;
    const changed = applyToolStyleChange(values, "arrow", {
      property: "arrow-start-node",
      value: "circle",
    });

    expect(changed).toMatchObject({
      changed: true,
      toolValues: { arrow: { startNode: "circle" } },
    });
    expect(values.arrow.startNode).toBe("none");
    const unchanged = applyToolStyleChange(changed.toolValues, "arrow", {
      property: "arrow-start-node",
      value: "circle",
    });
    expect(unchanged.changed).toBe(false);
    expect(unchanged.toolValues).toBe(changed.toolValues);
  });

  it("canonicalizes active-tool opacity when committing a style change", () => {
    const values = createBuiltInSettings().toolDefaults;

    const changed = applyToolStyleChange(values, "draw", {
      property: "opacity",
      value: 0.12345,
    });

    expect(changed.toolValues.pen.opacity).toBe(0.1235);
  });

  it("validates structural, opacity, color, and eraser inputs", () => {
    const values = createBuiltInSettings().toolDefaults;
    expect(() =>
      applyToolStyleChange(values, "table", { property: "table-columns", value: 13 }),
    ).toThrow(RangeError);
    expect(() => applyToolStyleChange(values, "draw", { property: "opacity", value: 2 })).toThrow(
      RangeError,
    );
    expect(() =>
      applyToolStyleChange(values, "eraser", { property: "eraser-radius", value: 2 }),
    ).toThrow(RangeError);
    expect(() =>
      applyToolStyleChange(values, "eraser", { property: "eraser-radius", value: 8.5 }),
    ).toThrow(/screen pixels/);
    expect(
      applyToolStyleChange(values, "eraser", { property: "eraser-radius", value: 64 }).toolValues
        .eraser.radius,
    ).toBe(64);
    expect(() =>
      applyToolStyleChange(values, "eraser", { property: "eraser-radius", value: 65 }),
    ).toThrow(/screen pixels/);
    expect(() =>
      applyToolStyleChange(values, "line", { property: "fill-opacity", value: 0.5 }),
    ).toThrow(/does not apply/);
  });
});

describe("active tool default families", () => {
  it("updates stroke, highlighter, shape, coordinate, and table defaults", () => {
    const draw = createBuiltInSettings().toolDefaults;
    expect(
      applyToolStyleChange(draw, "draw", {
        property: "color",
        value: { type: "rgba", value: "#FF00AAFF" },
      }).toolValues.pen,
    ).toMatchObject({ color: { type: "rgba", value: "#FF00AAFF" } });
    expect(
      applyToolStyleChange(draw, "draw", { property: "stroke-width", value: 2 }).toolValues.pen,
    ).toMatchObject({ width: 2 });
    expect(
      applyToolStyleChange(draw, "draw", { property: "pressure-enabled", value: false }).toolValues
        .pen,
    ).toMatchObject({ pressureEnabled: false });

    const highlighter = createBuiltInSettings().toolDefaults;
    expect(
      applyToolStyleChange(highlighter, "highlighter", {
        property: "opacity",
        value: 0.12345,
      }).toolValues.highlighter,
    ).toMatchObject({ opacity: 0.1235 });
    const straight = createBuiltInSettings().toolDefaults;
    expect(
      applyToolStyleChange(straight, "straight-highlighter", {
        property: "stroke-width",
        value: 14,
      }).toolValues.straightHighlighter,
    ).toMatchObject({ width: 14 });

    const shapeValues = createBuiltInSettings().toolDefaults;
    const shapeChange = applyToolStyleChange(shapeValues, "rectangle", {
      property: "outline-color",
      value: { type: "rgba", value: "#00AAFFFF" },
    });
    expect(shapeChange.toolValues.shapes.rectangle).toMatchObject({
      outlineColor: { type: "rgba", value: "#00AAFFFF" },
    });
    for (const change of [
      { property: "outline-width", value: 8 },
      { property: "outline-style", value: "dotted" },
      { property: "outline-opacity", value: 0.25 },
      { property: "fill-color", value: { type: "theme-text" } },
      { property: "fill-opacity", value: 0.75 },
    ] as const) {
      const result = applyToolStyleChange(
        createBuiltInSettings().toolDefaults,
        "rectangle",
        change,
      );
      expect(result.changed).toBe(true);
    }

    const coordinate = createBuiltInSettings().toolDefaults;
    expect(
      applyToolStyleChange(coordinate, "coordinate-system", {
        property: "coordinate-dimension",
        value: "3d",
      }).toolValues.coordinateSystem,
    ).toEqual({ dimension: "3d" });
    const table = createBuiltInSettings().toolDefaults;
    expect(
      applyToolStyleChange(table, "table", { property: "table-columns", value: 12 }).toolValues
        .table,
    ).toEqual({ columns: 12 });
  });
});

describe("active tool compatibility", () => {
  it("preserves no-op tool defaults and rejects unsupported tool properties", () => {
    const values = createBuiltInSettings().toolDefaults;
    expect(
      applyToolStyleChange(values, "draw", {
        property: "color",
        value: { type: "theme-text" },
      }),
    ).toEqual({ toolValues: values, changed: false });
    expect(
      applyToolStyleChange(values, "rectangle", {
        property: "fill-opacity",
        value: 0.15,
      }),
    ).toEqual({ toolValues: values, changed: false });
    expect(() =>
      applyToolStyleChange(values, "select", { property: "color", value: { type: "theme-text" } }),
    ).toThrow(/does not apply/);
    expect(() =>
      applyToolStyleChange(values, "line", { property: "fill-color", value: null }),
    ).toThrow(/does not apply/);
    expect(() =>
      applyToolStyleChange(values, "rectangle", {
        property: "color",
        value: { type: "theme-text" },
      }),
    ).toThrow(/does not apply/);
  });
});

function rectangleForStyleTest(
  defaults: ReturnType<typeof createBuiltInSettings>["toolDefaults"],
): BoxShapeElementV1 {
  return createDragElement({
    identity: { ...identity, id: "123e4567-e89b-42d3-a456-426614174004" },
    tool: "rectangle",
    start: { x: 10, y: 10 },
    end: { x: 100, y: 100 },
    defaults,
  }) as BoxShapeElementV1;
}
