import type { ShapeId } from "./toolbar-types";
import type { ArrowNodeV1 } from "../../domain/schema/public";
import type { SelectionAreaV1 } from "../../domain/settings/types";

export const STRAIGHT_HIGHLIGHTER_ICON_ID = "inkbook-straight-highlighter";
export const CAUTION_ERASER_ICON_ID = "inkbook-eraser-caution";
export const OPACITY_ICON_ID = "inkbook-opacity";
export const PRESSURE_SENSITIVITY_ICON_ID = "inkbook-pressure-sensitivity";
export const BACKGROUND_SQUARES_ICON_ID = "inkbook-background-squares";

export const SELECTION_AREA_ICON_IDS: Readonly<Record<SelectionAreaV1, string>> = {
  rectangle: "square-mouse-pointer",
  lasso: "lasso-select",
};

export const SHAPE_ICON_IDS: Readonly<Record<ShapeId, string>> = {
  line: "inkbook-shape-line",
  arrow: "inkbook-shape-arrow",
  rectangle: "inkbook-shape-rectangle",
  ellipse: "inkbook-shape-ellipse",
  triangle: "inkbook-shape-triangle",
  octagon: "inkbook-shape-octagon",
  parallelogram: "inkbook-shape-parallelogram",
  diamond: "inkbook-shape-diamond",
  "coordinate-system": "inkbook-shape-coordinate-system",
  table: "inkbook-shape-table",
};

export interface ActiveShapeIconState {
  readonly arrowStart: ArrowNodeV1;
  readonly arrowEnd: ArrowNodeV1;
  readonly coordinateDimension: "2d" | "3d";
}

export function arrowShapeIconId(start: ArrowNodeV1, end: ArrowNodeV1): string {
  return `inkbook-shape-arrow-${start}-${end}`;
}

export function coordinateSystemIconId(dimension: "2d" | "3d"): string {
  return `inkbook-shape-coordinate-system-${dimension}`;
}

export function selectionAreaIconId(area: SelectionAreaV1): string {
  return SELECTION_AREA_ICON_IDS[area];
}

export function activeShapeIconId(shape: ShapeId, state: ActiveShapeIconState): string {
  if (shape === "arrow") return arrowShapeIconId(state.arrowStart, state.arrowEnd);
  if (shape === "coordinate-system") return coordinateSystemIconId(state.coordinateDimension);
  return SHAPE_ICON_IDS[shape];
}
