import type { ShapeId } from "./flyout-types";

export const STRAIGHT_HIGHLIGHTER_ICON_ID = "inkbook-straight-highlighter";

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
