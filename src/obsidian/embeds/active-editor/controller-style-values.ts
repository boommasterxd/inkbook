import type {
  ArrowNodeV1,
  ColorV1,
  OutlineStyleV1,
  StrokeStyleV1,
} from "../../../domain/schema/public";
import { BUILT_IN_COLORS } from "../../../domain/settings/defaults";
import { OUTLINE_WIDTHS, PEN_WIDTHS } from "../../../domain/settings/types";
import type { StyleChange } from "../../../editor/tools/style-change";

export function styleChange(controlId: string, value: boolean | number | string): StyleChange {
  const text = specializedStyleChange(controlId, value);
  if (text !== null) return text;
  switch (controlId) {
    case "color":
    case "outline-color":
      return { property: controlId, value: parseColor(value, false) };
    case "fill-color":
      return { property: controlId, value: parseColor(value, true) };
    case "stroke-width":
      return { property: controlId, value: parseStrokeWidth(value) };
    case "outline-width":
      return { property: controlId, value: parseOutlineWidth(value) };
    case "opacity":
    case "outline-opacity":
    case "fill-opacity":
    case "eraser-radius":
      return { property: controlId, value: requireNumber(value, controlId) };
    case "pressure-enabled":
    case "hold-to-shape-enabled":
    case "snapping-enabled":
      return { property: controlId, value: requireBoolean(value, controlId) };
    case "outline-style":
      return { property: controlId, value: parseOutlineStyle(value) };
    case "arrow-start-node":
    case "arrow-end-node":
      return { property: controlId, value: parseArrowNode(value) };
    case "coordinate-dimension":
      return { property: controlId, value: parseDimension(value) };
    default:
      throw new RangeError(`Unknown style control: ${controlId}.`);
  }
}

function parseSelectionArea(value: boolean | number | string): "rectangle" | "lasso" {
  if (value === "rectangle" || value === "lasso") return value;
  throw new RangeError("The selection area must be rectangle or lasso.");
}

function parseSelectionInclusion(value: boolean | number | string): "fully-enclosed" | "touched" {
  if (value === "fully-enclosed" || value === "touched") return value;
  throw new RangeError("Selection inclusion must be fully-enclosed or touched.");
}

function parseColor(value: boolean | number | string, nullable: false): ColorV1;
function parseColor(value: boolean | number | string, nullable: true): ColorV1 | null;
function parseColor(value: boolean | number | string, nullable: boolean): ColorV1 | null {
  if (nullable && value === "none") return null;
  if (value === "theme-text") return { type: "theme-text" };
  const color = BUILT_IN_COLORS.find(
    (candidate) => candidate.type === "rgba" && candidate.value === value,
  );
  if (color?.type !== "rgba") throw new RangeError("The color is not an available style option.");
  return color;
}

function parseStrokeWidth(value: boolean | number | string): StrokeStyleV1["width"] {
  const width = typeof value === "string" ? Number(value) : value;
  const available = PEN_WIDTHS.find((candidate) => candidate === width);
  if (available !== undefined) return available;
  throw new RangeError("The stroke width is not an available style option.");
}

function parseOutlineWidth(value: boolean | number | string): OutlineStyleV1["outlineWidth"] {
  const width = typeof value === "string" ? Number(value) : value;
  const available = OUTLINE_WIDTHS.find((candidate) => candidate === width);
  if (available !== undefined) return available;
  throw new RangeError("The outline width is not an available style option.");
}

function parseOutlineStyle(value: boolean | number | string): OutlineStyleV1["outlineStyle"] {
  if (value === "solid" || value === "dashed" || value === "dotted") return value;
  throw new RangeError("The outline style is not an available style option.");
}

function parseArrowNode(value: boolean | number | string): ArrowNodeV1 {
  if (
    value === "none" ||
    value === "arrow" ||
    value === "triangle" ||
    value === "diamond" ||
    value === "circle"
  )
    return value;
  throw new RangeError("The arrow node is not an available style option.");
}

function parseDimension(value: boolean | number | string): "2d" | "3d" {
  if (value === "2d" || value === "3d") return value;
  throw new RangeError("The coordinate-system dimension must be 2d or 3d.");
}

function requireNumber(value: boolean | number | string, controlId: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new TypeError(`${controlId} requires a finite numeric value.`);
}

function requireBoolean(value: boolean | number | string, controlId: string): boolean {
  if (typeof value === "boolean") return value;
  throw new TypeError(`${controlId} requires a Boolean value.`);
}

function specializedStyleChange(
  controlId: string,
  value: boolean | number | string,
): StyleChange | null {
  switch (controlId) {
    case "table-columns":
      return { property: controlId, value: requireNumber(value, controlId) };
    case "selection-area":
      return { property: controlId, value: parseSelectionArea(value) };
    case "selection-inclusion":
      return { property: controlId, value: parseSelectionInclusion(value) };
    case "text-font-family":
      if (typeof value !== "string") throw new TypeError("A font family must be a string.");
      return { property: controlId, value };
    case "text-font-size":
    case "text-background-opacity":
      return { property: controlId, value: requireNumber(value, controlId) };
    case "text-background-color":
      return { property: controlId, value: parseColor(value, true) };
    case "text-bold":
    case "text-italic":
    case "text-underline":
    case "text-strikethrough":
      return { property: controlId, value: requireBoolean(value, controlId) };
    case "text-alignment":
      if (value !== "left" && value !== "center" && value !== "right" && value !== "justify")
        throw new RangeError("Invalid paragraph alignment.");
      return { property: controlId, value };
    default:
      return null;
  }
}
