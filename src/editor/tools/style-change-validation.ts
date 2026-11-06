import type {
  ArrowNodeV1,
  ColorV1,
  OutlineStyleV1,
  ShapeStyleV1,
  StrokeStyleV1,
} from "../../domain/schema/public";
import { canonicalizeUnitIntervalNumber, isRgbaColor } from "../../domain/schema/public";
import type { SelectionAreaV1, SelectionInclusionV1 } from "../../domain/settings/types";

export type StyleChange =
  | { readonly property: "selection-area"; readonly value: SelectionAreaV1 }
  | { readonly property: "selection-inclusion"; readonly value: SelectionInclusionV1 }
  | { readonly property: "color"; readonly value: ColorV1 }
  | { readonly property: "stroke-width"; readonly value: StrokeStyleV1["width"] }
  | { readonly property: "opacity"; readonly value: number }
  | { readonly property: "pressure-enabled"; readonly value: boolean }
  | { readonly property: "hold-to-shape-enabled"; readonly value: boolean }
  | { readonly property: "snapping-enabled"; readonly value: boolean }
  | { readonly property: "outline-color"; readonly value: ColorV1 }
  | { readonly property: "outline-width"; readonly value: OutlineStyleV1["outlineWidth"] }
  | { readonly property: "outline-style"; readonly value: OutlineStyleV1["outlineStyle"] }
  | { readonly property: "outline-opacity"; readonly value: number }
  | { readonly property: "fill-color"; readonly value: ShapeStyleV1["fillColor"] }
  | { readonly property: "fill-opacity"; readonly value: number }
  | { readonly property: "arrow-start-node"; readonly value: ArrowNodeV1 }
  | { readonly property: "arrow-end-node"; readonly value: ArrowNodeV1 }
  | { readonly property: "coordinate-dimension"; readonly value: "2d" | "3d" }
  | { readonly property: "table-columns"; readonly value: number }
  | { readonly property: "eraser-radius"; readonly value: number };

export function validateChange(change: StyleChange): void {
  if (
    (change.property === "pressure-enabled" ||
      change.property === "hold-to-shape-enabled" ||
      change.property === "snapping-enabled") &&
    typeof change.value !== "boolean"
  )
    throw new RangeError("Tool behavior preferences must be boolean values.");
  validateColorChange(change);
  validateOpacityChange(change);
  if (
    change.property === "table-columns" &&
    (!Number.isInteger(change.value) || change.value < 1 || change.value > 12)
  ) {
    throw new RangeError("Table columns must be an integer from 1 through 12.");
  }
  if (
    change.property === "eraser-radius" &&
    (!Number.isInteger(change.value) || change.value < 8 || change.value > 64)
  ) {
    throw new RangeError("Eraser radius must be an integer from 8 through 64 screen pixels.");
  }
}

export function canonicalStyleChange(change: StyleChange): StyleChange {
  validateChange(change);
  if (
    change.property !== "opacity" &&
    change.property !== "outline-opacity" &&
    change.property !== "fill-opacity"
  ) {
    return change;
  }
  return { ...change, value: canonicalizeUnitIntervalNumber(change.value) };
}

function validateColorChange(change: StyleChange): void {
  if (
    change.property !== "color" &&
    change.property !== "outline-color" &&
    change.property !== "fill-color"
  ) {
    return;
  }
  if (
    change.value !== null &&
    change.value.type !== "theme-text" &&
    !isRgbaColor(change.value.value)
  ) {
    throw new RangeError("Style colors must be theme-text or canonical RGBA values.");
  }
}

function validateOpacityChange(change: StyleChange): void {
  if (
    change.property !== "opacity" &&
    change.property !== "outline-opacity" &&
    change.property !== "fill-opacity"
  ) {
    return;
  }
  if (!Number.isFinite(change.value) || change.value < 0 || change.value > 1) {
    throw new RangeError("Style opacity must be from 0 through 1.");
  }
}
