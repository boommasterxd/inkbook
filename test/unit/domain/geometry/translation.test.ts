import { describe, expect, it } from "vitest";

import type {
  ArrowElementV1,
  LineElementV1,
  StraightHighlighterElementV1,
} from "../../../../src/domain/schema/public";
import { translateElementGeometry } from "../../../../src/domain/geometry/public";
import { coordinateSystem, rectangle } from "./fixtures";

const outlineStyle = {
  outlineColor: { type: "theme-text" as const },
  outlineWidth: 4 as const,
  outlineOpacity: 1,
  outlineStyle: "solid" as const,
};

const strokeStyle = {
  color: { type: "theme-text" as const },
  width: 8 as const,
  opacity: 1,
  pressureEnabled: false,
  smoothing: 0.5 as const,
};

describe("runtime geometry translation", () => {
  it("translates every canonical coordinate of a runtime stroke", () => {
    const source = {
      createdAt: 0,
      id: "00000000-0000-4000-8000-000000000010",
      kind: "stroke",
      pivot: { x: 5, y: 5 },
      points: new Float64Array([0, 0, 0.5, 10, 10, 1]),
      rotation: 0,
      style: {
        color: { type: "theme-text" },
        opacity: 1,
        pressureEnabled: true,
        smoothing: 0.5,
        width: 2,
      },
      tool: "pen",
    } as const;

    const translated = translateElementGeometry(source as never, { x: 2, y: 3 });

    expect(translated.kind).toBe("stroke");
    if (translated.kind !== "stroke") return;
    expect(translated.points).toEqual(new Float64Array([2, 3, 0.5, 12, 13, 1]));
    expect(translated.pivot).toEqual({ x: 7, y: 8 });
  });

  it("returns the original element for a zero translation", () => {
    const source = rectangle();
    expect(translateElementGeometry(source, { x: 0, y: 0 })).toBe(source);
  });
});

describe("stroke and linear geometry translation", () => {
  it("copies ordinary stroke arrays and translates every linear variant", () => {
    const stroke = {
      createdAt: 0,
      id: "00000000-0000-4000-8000-000000000011",
      kind: "stroke" as const,
      pivot: { x: 5, y: 5 },
      points: [0, 0, 0.5, 10, 10, 1],
      rotation: 0,
      style: { ...strokeStyle },
      tool: "pen" as const,
    };
    const copied = translateElementGeometry(stroke, { x: 2, y: 3 });
    expect(copied).not.toBe(stroke);
    expect(copied).toMatchObject({
      pivot: { x: 7, y: 8 },
      points: [2, 3, 0.5, 12, 13, 1],
    });

    const line: LineElementV1 = {
      createdAt: 0,
      id: "00000000-0000-4000-8000-000000000012",
      kind: "line",
      pivot: { x: 5, y: 5 },
      rotation: 0,
      start: { x: 0, y: 0 },
      end: { x: 10, y: 10 },
      bend: { x: 5, y: 8 },
      startConnection: null,
      endConnection: null,
      startNode: "none",
      endNode: "none",
      style: outlineStyle,
    };
    const translatedLine = translateElementGeometry(line, { x: 2, y: 3 }) as LineElementV1;
    expect(translatedLine).toMatchObject({
      start: { x: 2, y: 3 },
      end: { x: 12, y: 13 },
      bend: { x: 7, y: 11 },
      pivot: { x: 7, y: 8 },
    });

    const straight: StraightHighlighterElementV1 = {
      createdAt: 0,
      id: "00000000-0000-4000-8000-000000000013",
      kind: "straight-highlighter",
      pivot: { x: 5, y: 5 },
      rotation: 0,
      start: { x: 0, y: 0 },
      end: { x: 10, y: 10 },
      bend: null,
      startNode: "none",
      endNode: "none",
      style: strokeStyle,
    };
    expect(translateElementGeometry(straight, { x: 2, y: 3 })).toMatchObject({
      start: { x: 2, y: 3 },
      end: { x: 12, y: 13 },
    });

    const arrow: ArrowElementV1 = {
      ...line,
      id: "00000000-0000-4000-8000-000000000014",
      kind: "arrow",
      startNode: "circle",
      endNode: "arrow",
    };
    const straightArrow = translateElementGeometry({ ...arrow, bend: null }, { x: 2, y: 3 });
    expect(straightArrow).toMatchObject({ bend: null, start: { x: 2, y: 3 } });
  });

  it("keeps coordinate dimensionality and translates generic shape geometry", () => {
    const translated2d = translateElementGeometry(coordinateSystem("2d"), { x: 2, y: 3 });
    expect(translated2d).toMatchObject({
      dimension: "2d",
      origin: { x: 102, y: 103 },
      axes: [
        { x: 202, y: 103 },
        { x: 102, y: 3 },
      ],
    });
    const translated3d = translateElementGeometry(coordinateSystem("3d"), { x: 2, y: 3 });
    expect(translated3d).toMatchObject({
      dimension: "3d",
      axes: [
        { x: 202, y: 103 },
        { x: 102, y: 3 },
        { x: 52, y: 153 },
      ],
    });

    const shape = rectangle({ x: 10, y: 20, pivot: { x: 60, y: 45 } });
    expect(translateElementGeometry(shape, { x: 2, y: 3 })).toMatchObject({
      x: 12,
      y: 23,
      pivot: { x: 62, y: 48 },
    });
  });
});
