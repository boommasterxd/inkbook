import { describe, expect, it } from "vitest";

import { validateInkElementV1 } from "../../../../src/domain/schema/public";
import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { createDragElement, createFreehandElement } from "../../../../src/editor/tools/creation";

const identity = { id: "123e4567-e89b-42d3-a456-426614174000", createdAt: 42 };

describe("freehand and linear tool element creation", () => {
  it("canonicalizes freehand samples and derives the unrotated bounds center", () => {
    const defaults = createBuiltInSettings().toolDefaults;
    const pen = createFreehandElement({
      identity,
      tool: "draw",
      samples: [10.12345, 30.5555, 0.77777, 20.98765, 10.1111, 0.2],
      defaults,
    });

    expect(pen).toMatchObject({
      kind: "stroke",
      tool: "pen",
      points: [10.123, 30.555, 0.7778, 20.988, 10.111, 0.2],
      pivot: { x: 15.556, y: 20.333 },
      style: { width: 4, pressureEnabled: true, smoothing: 0.5 },
    });
    expect(validateInkElementV1(pen).ok).toBe(true);
  });

  it("forces highlighter pressure off without mutating the defaults", () => {
    const defaults = createBuiltInSettings().toolDefaults;
    const highlighter = createFreehandElement({
      identity,
      tool: "highlighter",
      samples: [1, 2, 0.8],
      defaults,
    });

    expect(highlighter.style).toMatchObject({ width: 8, opacity: 0.4, pressureEnabled: false });
    expect(defaults.highlighter).not.toHaveProperty("pressureEnabled");
  });

  it("creates and clamps every linear tool", () => {
    const defaults = createBuiltInSettings().toolDefaults;
    const line = createDragElement({
      identity,
      tool: "line",
      start: { x: 10, y: 20 },
      end: { x: 10, y: 20 },
      defaults,
    });
    const arrow = createDragElement({
      identity,
      tool: "arrow",
      start: { x: 0, y: 0 },
      end: { x: 4, y: 0 },
      defaults,
    });
    const straight = createDragElement({
      identity,
      tool: "straight-highlighter",
      start: { x: 0, y: 0 },
      end: { x: 0, y: 4 },
      defaults,
    });

    expect(line).toMatchObject({ start: { x: 10, y: 20 }, end: { x: 18, y: 20 } });
    expect(arrow).toMatchObject({ end: { x: 8, y: 0 }, startNode: "none", endNode: "arrow" });
    expect(straight).toMatchObject({
      end: { x: 0, y: 8 },
      bend: null,
      style: { pressureEnabled: false, opacity: 0.4 },
    });
  });

  it("rejects incomplete or empty stroke sample input", () => {
    const defaults = createBuiltInSettings().toolDefaults;
    expect(() => createFreehandElement({ identity, tool: "draw", samples: [], defaults })).toThrow(
      RangeError,
    );
    expect(() =>
      createFreehandElement({ identity, tool: "draw", samples: [1, 2], defaults }),
    ).toThrow(RangeError);
  });
});

describe("shape tool element creation", () => {
  it.each(["rectangle", "ellipse", "triangle", "octagon", "parallelogram", "diamond"] as const)(
    "creates normalized %s geometry with fill style",
    (tool) => {
      const defaults = createBuiltInSettings().toolDefaults;
      const shape = createDragElement({
        identity,
        tool,
        start: { x: 100, y: 80 },
        end: { x: 40, y: 20 },
        defaults,
      });

      expect(shape).toMatchObject({ kind: tool, x: 40, y: 20, width: 60, height: 60 });
      expect(shape.style).toHaveProperty("fillColor", null);
      expect(validateInkElementV1(shape).ok).toBe(true);
    },
  );

  it("creates two- and three-dimensional coordinate systems", () => {
    const defaults = createBuiltInSettings().toolDefaults;
    const twoDimensional = createDragElement({
      identity,
      tool: "coordinate-system",
      start: { x: 100, y: 100 },
      end: { x: 100, y: 100 },
      defaults,
    });
    defaults.coordinateSystem.dimension = "3d";
    const threeDimensional = createDragElement({
      identity,
      tool: "coordinate-system",
      start: { x: 100, y: 100 },
      end: { x: 200, y: 0 },
      defaults,
    });

    expect(twoDimensional).toMatchObject({
      dimension: "2d",
      origin: { x: 100, y: 100 },
      axes: [
        { x: 300, y: 100 },
        { x: 100, y: -100 },
      ],
    });
    expect(threeDimensional).toMatchObject({
      dimension: "3d",
      axes: [
        { x: 200, y: 100 },
        { x: 100, y: 0 },
        { x: 50, y: 150 },
      ],
    });
  });

  it("creates a table with equal canonical columns and a bounded header", () => {
    const defaults = createBuiltInSettings().toolDefaults;
    defaults.table.columns = 4;
    const table = createDragElement({
      identity,
      tool: "table",
      start: { x: 300, y: 200 },
      end: { x: 100, y: 150 },
      defaults,
    });

    expect(table).toMatchObject({
      kind: "table",
      x: 100,
      y: 120,
      columnWidth: 50,
      columns: 4,
      height: 80,
      headerHeight: 24,
      pivot: { x: 200, y: 160 },
    });
  });
});
