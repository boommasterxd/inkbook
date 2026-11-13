import { changeTextElement, textDefaultsMatch, textStylePatch } from "./text-style-change";
import { changeCoordinateSystemDimension, changeTableColumns } from "../../domain/geometry/public";
import type {
  ColorV1,
  InkElementV1,
  OutlineStyleV1,
  ShapeStyleV1,
  StrokeStyleV1,
} from "../../domain/schema/public";
import { validateInternalStyleReplacement } from "../../domain/elements/runtime-replacement-validation";
import type { StartupToolV1, ToolDefaultsV1 } from "../../domain/settings/types";

import { canonicalStyleChange, validateChange, type StyleChange } from "./style-change-validation";
export type { StyleChange } from "./style-change-validation";

export interface SelectionStyleChangeResult {
  readonly elements: readonly InkElementV1[];
  readonly changed: boolean;
}

export interface ToolStyleChangeResult {
  readonly toolValues: ToolDefaultsV1;
  readonly changed: boolean;
}

export function applySelectionStyleChange(
  elements: readonly InkElementV1[],
  change: StyleChange,
): SelectionStyleChangeResult {
  const canonicalChange = canonicalStyleChange(change);
  assertSelectionCompatibility(elements, canonicalChange);
  const changedElements = elements.map((element) =>
    changeElement(element, elementStyleChange(element, canonicalChange)),
  );
  const changed = changedElements.some((element, index) => element !== elements[index]);
  return { elements: changed ? changedElements : elements, changed };
}

export function applyToolStyleChange(
  toolValues: ToolDefaultsV1,
  tool: StartupToolV1,
  change: StyleChange,
): ToolStyleChangeResult {
  const canonicalChange = canonicalStyleChange(change);
  assertToolCompatibility(tool, canonicalChange);
  if (toolValueMatches(toolValues, tool, canonicalChange)) {
    return { toolValues, changed: false };
  }
  const next = structuredClone(toolValues);
  changeToolValues(next, tool, canonicalChange);
  return { toolValues: next, changed: true };
}

function elementStyleChange(element: InkElementV1, change: StyleChange): StyleChange {
  if (isStrokeStyled(element) || element.kind === "text") return change;
  switch (change.property) {
    case "color":
      return { property: "outline-color", value: change.value };
    case "stroke-width":
      return { property: "outline-width", value: change.value };
    case "opacity":
      return { property: "outline-opacity", value: change.value };
    default:
      return change;
  }
}

function changeElement(element: InkElementV1, change: StyleChange): InkElementV1 {
  validateChange(change);
  if (isToolOnlyChange(change))
    throw new RangeError(`${change.property} does not apply to an existing selection.`);
  if (element.kind === "text") {
    const changed = changeTextElement(element, change);
    return changed === element ? element : validateStyleReplacement(element, changed);
  }
  if (elementValueMatches(element, change)) return element;
  let result: InkElementV1;
  switch (change.property) {
    case "color":
      result = withStyle(element, { color: structuredClone(change.value) });
      break;
    case "stroke-width":
      result = withStyle(element, { width: change.value });
      break;
    case "opacity":
      result = withStyle(element, { opacity: change.value });
      break;
    case "outline-color":
      result = withStyle(element, { outlineColor: structuredClone(change.value) });
      break;
    case "outline-width":
      result = withStyle(element, { outlineWidth: change.value });
      break;
    case "outline-style":
      result = withStyle(element, { outlineStyle: change.value });
      break;
    case "outline-opacity":
      result = withStyle(element, { outlineOpacity: change.value });
      break;
    case "fill-color":
      result = withStyle(element, { fillColor: structuredClone(change.value) });
      break;
    case "fill-opacity":
      result = withStyle(element, { fillOpacity: change.value });
      break;
    case "arrow-start-node":
      result = { ...element, startNode: change.value } as InkElementV1;
      break;
    case "arrow-end-node":
      result = { ...element, endNode: change.value } as InkElementV1;
      break;
    case "coordinate-dimension":
      result = changeCoordinateSystemDimension(element as never, change.value);
      break;
    case "table-columns":
      result = changeTableColumns(element as never, change.value);
      break;
    default:
      throw new RangeError(`Unsupported style property ${change.property}.`);
  }
  return validateStyleReplacement(element, result);
}

function validateStyleReplacement(element: InkElementV1, result: InkElementV1): InkElementV1 {
  const validation = validateInternalStyleReplacement(element, result);
  if (!validation.ok) throw new RangeError(`${validation.error.path}: ${validation.error.message}`);
  return validation.value;
}

function assertSelectionCompatibility(
  elements: readonly InkElementV1[],
  change: StyleChange,
): void {
  if (elements.length === 0) throw new RangeError("A style change requires a non-empty selection.");
  if (isToolOnlyChange(change))
    throw new RangeError(`Style property ${change.property} is not shared by the selection.`);
  const compatible = elements.every((element) => {
    if (change.property.startsWith("text-")) return element.kind === "text";
    switch (change.property) {
      case "color":
      case "opacity":
        return true;
      case "stroke-width":
        return element.kind !== "text";
      case "outline-color":
      case "outline-width":
      case "outline-style":
      case "outline-opacity":
        return !isStrokeStyled(element) && element.kind !== "text";
      case "fill-color":
      case "fill-opacity":
        return isClosedShape(element) || element.kind === "text";
      case "arrow-start-node":
      case "arrow-end-node":
        return element.kind === "arrow";
      case "coordinate-dimension":
        return element.kind === "coordinate-system";
      case "table-columns":
        return element.kind === "table";
      default:
        return false;
    }
  });
  if (!compatible)
    throw new RangeError(`Style property ${change.property} is not shared by the selection.`);
}

function assertToolCompatibility(tool: StartupToolV1, change: StyleChange): void {
  if (change.property === "pressure-enabled" || change.property === "hold-to-shape-enabled") {
    if (tool !== "draw")
      throw new RangeError(`Style property ${change.property} does not apply to ${tool}.`);
    return;
  }
  if (change.property === "snapping-enabled") {
    if (tool !== "line" && tool !== "arrow")
      throw new RangeError(`Style property ${change.property} does not apply to ${tool}.`);
    return;
  }
  if (change.property.startsWith("text-")) {
    if (tool !== "text") throw new RangeError(`Text style does not apply to ${tool}.`);
    return;
  }
  const compatible = (() => {
    switch (change.property) {
      case "color":
      case "opacity":
      case "stroke-width":
        return supportsStrokePaint(tool, change.property);
      case "outline-color":
      case "outline-width":
      case "outline-style":
      case "outline-opacity":
        return !isNonShapeTool(tool);
      case "fill-color":
      case "fill-opacity":
        return isClosedShapeTool(tool);
      case "arrow-start-node":
      case "arrow-end-node":
        return tool === "arrow";
      case "coordinate-dimension":
        return tool === "coordinate-system";
      case "table-columns":
        return tool === "table";
      case "eraser-radius":
        return tool === "eraser";
      case "selection-area":
      case "selection-inclusion":
        return tool === "select";
      default:
        return false;
    }
  })();
  if (!compatible)
    throw new RangeError(`Style property ${change.property} does not apply to ${tool}.`);
}

function changeToolValues(values: ToolDefaultsV1, tool: StartupToolV1, change: StyleChange): void {
  if (tool === "text") {
    Object.assign(values.text, textStylePatch(change));
    return;
  }
  if (change.property === "hold-to-shape-enabled") {
    values.pen.holdToShapeEnabled = change.value;
    return;
  }
  if (change.property === "snapping-enabled") {
    values[tool as "line" | "arrow"].snappingEnabled = change.value;
    return;
  }
  if (change.property === "selection-area") {
    values.select.area = change.value;
    return;
  }
  if (change.property === "selection-inclusion") {
    values.select.inclusion = change.value;
    return;
  }
  if (change.property === "eraser-radius") {
    values.eraser.radius = change.value;
    return;
  }
  if (change.property === "coordinate-dimension") {
    values.coordinateSystem.dimension = change.value;
    return;
  }
  if (change.property === "table-columns") {
    values.table.columns = change.value;
    return;
  }
  if (change.property === "arrow-start-node" || change.property === "arrow-end-node") {
    const key = change.property === "arrow-start-node" ? "startNode" : "endNode";
    values.arrow[key] = change.value;
    return;
  }
  const target = strokeToolDefaults(values, tool);
  if (target !== null) {
    if (change.property === "color") target.color = structuredClone(change.value);
    else if (change.property === "stroke-width") target.width = change.value;
    else if (change.property === "opacity") target.opacity = change.value;
    else if (change.property === "pressure-enabled" && "pressureEnabled" in target) {
      target.pressureEnabled = change.value;
    }
    return;
  }
  const style = values.shapes[tool as keyof ToolDefaultsV1["shapes"]];
  Object.assign(style, toolStylePatch(change));
}

function toolStylePatch(change: StyleChange): object {
  switch (change.property) {
    case "outline-color":
      return { outlineColor: structuredClone(change.value) };
    case "outline-width":
      return { outlineWidth: change.value };
    case "outline-style":
      return { outlineStyle: change.value };
    case "outline-opacity":
      return { outlineOpacity: change.value };
    case "fill-color":
      return { fillColor: structuredClone(change.value) };
    case "fill-opacity":
      return { fillOpacity: change.value };
    default:
      return {};
  }
}

function withStyle(element: InkElementV1, patch: object): InkElementV1 {
  return { ...element, style: { ...element.style, ...patch } } as InkElementV1;
}

function elementValueMatches(element: InkElementV1, change: StyleChange): boolean {
  if (isToolOnlyChange(change)) return false;
  const style = element.style as Partial<StrokeStyleV1 & ShapeStyleV1>;
  switch (change.property) {
    case "color":
      return equalColor(style.color, change.value);
    case "stroke-width":
      return style.width === change.value;
    case "opacity":
      return style.opacity === change.value;
    case "outline-color":
      return equalColor(style.outlineColor, change.value);
    case "outline-width":
      return style.outlineWidth === change.value;
    case "outline-style":
      return style.outlineStyle === change.value;
    case "outline-opacity":
      return style.outlineOpacity === change.value;
    case "fill-color":
      return equalColor(style.fillColor, change.value);
    case "fill-opacity":
      return style.fillOpacity === change.value;
    case "arrow-start-node":
      return element.kind === "arrow" && element.startNode === change.value;
    case "arrow-end-node":
      return element.kind === "arrow" && element.endNode === change.value;
    case "coordinate-dimension":
      return element.kind === "coordinate-system" && element.dimension === change.value;
    case "table-columns":
      return element.kind === "table" && element.columns === change.value;
    default:
      return false;
  }
}

function isToolOnlyChange(change: StyleChange): change is Extract<
  StyleChange,
  {
    readonly property:
      | "pressure-enabled"
      | "hold-to-shape-enabled"
      | "snapping-enabled"
      | "eraser-radius"
      | "selection-area"
      | "selection-inclusion";
  }
> {
  return (
    change.property === "pressure-enabled" ||
    change.property === "hold-to-shape-enabled" ||
    change.property === "snapping-enabled" ||
    change.property === "eraser-radius" ||
    change.property === "selection-area" ||
    change.property === "selection-inclusion"
  );
}

function toolValueMatches(
  values: ToolDefaultsV1,
  tool: StartupToolV1,
  change: StyleChange,
): boolean {
  if (tool === "text") return textDefaultsMatch(values.text, change);
  if (change.property === "hold-to-shape-enabled")
    return values.pen.holdToShapeEnabled === change.value;
  if (change.property === "snapping-enabled")
    return values[tool as "line" | "arrow"].snappingEnabled === change.value;
  if (change.property === "selection-area") return values.select.area === change.value;
  if (change.property === "selection-inclusion") return values.select.inclusion === change.value;
  if (change.property === "eraser-radius") return values.eraser.radius === change.value;
  if (change.property === "coordinate-dimension")
    return values.coordinateSystem.dimension === change.value;
  if (change.property === "table-columns") return values.table.columns === change.value;
  if (change.property === "arrow-start-node") return values.arrow.startNode === change.value;
  if (change.property === "arrow-end-node") return values.arrow.endNode === change.value;
  const stroke = strokeToolDefaults(values, tool);
  if (stroke !== null) return strokeValueMatches(stroke, change);
  if (!isShapeTool(tool)) throw new RangeError(`Tool ${tool} has no shape style.`);
  return shapeValueMatches(values.shapes[tool], change);
}

function strokeValueMatches(
  values: ToolDefaultsV1["pen"] | ToolDefaultsV1["highlighter"],
  change: StyleChange,
): boolean {
  if (change.property === "color") return equalColor(values.color, change.value);
  if (change.property === "stroke-width") return values.width === change.value;
  if (change.property === "opacity") return values.opacity === change.value;
  return (
    change.property === "pressure-enabled" &&
    "pressureEnabled" in values &&
    values.pressureEnabled === change.value
  );
}

function shapeValueMatches(style: OutlineStyleV1 | ShapeStyleV1, change: StyleChange): boolean {
  if (change.property === "outline-color") return equalColor(style.outlineColor, change.value);
  if (change.property === "outline-width") return style.outlineWidth === change.value;
  if (change.property === "outline-style") return style.outlineStyle === change.value;
  if (change.property === "outline-opacity") return style.outlineOpacity === change.value;
  if (change.property === "fill-color")
    return "fillColor" in style && equalColor(style.fillColor, change.value);
  return (
    change.property === "fill-opacity" &&
    "fillOpacity" in style &&
    style.fillOpacity === change.value
  );
}

function equalColor(left: ColorV1 | null | undefined, right: ColorV1 | null): boolean {
  if (left === null || left === undefined || right === null) return left === right;
  return (
    left.type === right.type &&
    (left.type === "theme-text" || left.value === (right as typeof left).value)
  );
}

function strokeToolDefaults(
  values: ToolDefaultsV1,
  tool: StartupToolV1,
): ToolDefaultsV1["pen"] | ToolDefaultsV1["highlighter"] | null {
  if (tool === "draw") return values.pen;
  if (tool === "highlighter") return values.highlighter;
  if (tool === "straight-highlighter") return values.straightHighlighter;
  return null;
}

function isStrokeStyled(element: InkElementV1): boolean {
  return element.kind === "stroke" || element.kind === "straight-highlighter";
}

function isClosedShape(element: InkElementV1): boolean {
  return isClosedShapeTool(element.kind as StartupToolV1);
}

function isShapeTool(tool: StartupToolV1): tool is keyof ToolDefaultsV1["shapes"] {
  return !isNonShapeTool(tool);
}

function isClosedShapeTool(tool: StartupToolV1): boolean {
  return (
    tool === "rectangle" ||
    tool === "ellipse" ||
    tool === "triangle" ||
    tool === "octagon" ||
    tool === "star" ||
    tool === "parallelogram" ||
    tool === "diamond"
  );
}

function isNonShapeTool(tool: StartupToolV1): boolean {
  return (
    tool === "select" ||
    tool === "eraser" ||
    tool === "text" ||
    tool === "draw" ||
    tool === "highlighter" ||
    tool === "straight-highlighter"
  );
}

function supportsStrokePaint(tool: StartupToolV1, property: string): boolean {
  return (
    tool === "draw" ||
    tool === "highlighter" ||
    tool === "straight-highlighter" ||
    (tool === "text" && property !== "stroke-width")
  );
}
