import type {
  BoxShapeElementV1,
  CoordinateSystemElementV1,
  StrokeStyleV1,
  TableElementV1,
} from "../../../../src/domain/schema/public";
import { outlineStyle, shapeStyle } from "../schema/fixtures";

export { outlineStyle } from "../schema/fixtures";

export const strokeStyle: StrokeStyleV1 = {
  color: { type: "theme-text" },
  width: 8,
  opacity: 1,
  pressureEnabled: false,
  smoothing: 0.5,
};

export function rectangle(overrides: Partial<BoxShapeElementV1> = {}): BoxShapeElementV1 {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    createdAt: 0,
    kind: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    rotation: 0,
    pivot: { x: 50, y: 25 },
    style: shapeStyle,
    ...overrides,
  };
}

export function coordinateSystem(dimension: "2d" | "3d" = "2d"): CoordinateSystemElementV1 {
  const base = {
    id: "00000000-0000-4000-8000-000000000002",
    createdAt: 0,
    kind: "coordinate-system" as const,
    origin: { x: 100, y: 100 },
    rotation: 0,
    pivot: { x: 100, y: 100 },
    style: outlineStyle,
  };
  return dimension === "2d"
    ? {
        ...base,
        dimension,
        axes: [
          { x: 200, y: 100 },
          { x: 100, y: 0 },
        ],
      }
    : {
        ...base,
        dimension,
        axes: [
          { x: 200, y: 100 },
          { x: 100, y: 0 },
          { x: 50, y: 150 },
        ],
      };
}

export function table(overrides: Partial<TableElementV1> = {}): TableElementV1 {
  return {
    id: "00000000-0000-4000-8000-000000000003",
    createdAt: 0,
    kind: "table",
    x: 10,
    y: 20,
    columnWidth: 50,
    height: 100,
    columns: 3,
    headerHeight: 30,
    rotation: 0,
    pivot: { x: 85, y: 70 },
    style: outlineStyle,
    ...overrides,
  };
}
