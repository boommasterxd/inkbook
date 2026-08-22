import { describe, expect, it } from "vitest";

import type {
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
      columnWidth: 100,
      x: 50,
      y: 150,
      pivot: { x: 250, y: 250 },
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
      columnWidth: 100,
      x: 200,
      y: 0,
      pivot: { x: 250, y: 100 },
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
