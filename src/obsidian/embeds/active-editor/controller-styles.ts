import {
  type ArrowNodeV1,
  type ColorV1,
  type InkElementV1,
  type OutlineStyleV1,
  type StrokeStyleV1,
} from "../../../domain/schema/public";
import { BUILT_IN_COLORS } from "../../../domain/settings/defaults";
import {
  OUTLINE_WIDTHS,
  PEN_WIDTHS,
  type StartupToolV1,
  type ToolDefaultsV1,
} from "../../../domain/settings/types";
import {
  applySelectionStyleChange,
  applyToolStyleChange,
  summarizeActiveToolStyle,
  summarizeSelectionStyle,
  type OutlineSelectionStyleSummary,
  type SelectionStyleSummary,
  type StyleChange,
} from "../../../editor/tools/public";
import type { ToolbarStyleIconState } from "../../../rendering/ui/index";
import type { ActiveShapeIconState } from "../../../rendering/ui/icon-ids";
import type { StyleChoiceOption, StyleControl } from "../../menus/editor-menu-types";
import { createStructuralStyleControls } from "../../menus/structural-style-controls";
import {
  ARROW_NODE_STYLE_OPTIONS,
  COLOR_STYLE_OPTIONS,
  createToolStyleControls,
  FILL_COLOR_STYLE_OPTIONS,
  OUTLINE_STYLE_OPTIONS,
  OUTLINE_WIDTH_STYLE_OPTIONS,
  PEN_WIDTH_STYLE_OPTIONS,
  serializeNullableStyleColor,
  serializeStyleColor,
} from "../../menus/tool-style-controls";

export interface ActiveEditorStyleContext {
  readonly defaults: ToolDefaultsV1;
  readonly selection: readonly InkElementV1[];
  readonly tool: StartupToolV1;
}

export interface SelectionStyleReplacement {
  readonly previous: readonly InkElementV1[];
  readonly replacements: readonly InkElementV1[];
}

export function createActiveEditorStyleControls(
  context: ActiveEditorStyleContext,
): readonly StyleControl[] {
  if (context.selection.length > 0) {
    return selectionControls(summarizeSelectionStyle(context.selection));
  }
  return createToolStyleControls(context.defaults, context.tool);
}

export function createActiveEditorStyleIcon(
  defaults: ToolDefaultsV1,
  tool: StartupToolV1,
): ToolbarStyleIconState {
  const summary = summarizeActiveToolStyle(defaults, tool);
  if (summary === null || summary.kind === "eraser" || summary.kind === "select") {
    return neutralStyleIcon();
  }
  if (summary.kind === "stroke") {
    return {
      fillColor: null,
      fillOpacity: 0,
      outlineColor: summary.color,
      outlineStyle: "solid",
    };
  }
  return {
    fillColor: summary.fill?.fillColor ?? null,
    fillOpacity: summary.fill?.fillOpacity ?? 0,
    outlineColor: summary.style.outlineColor,
    outlineStyle: summary.style.outlineStyle,
  };
}

export function createActiveShapeIcon(defaults: ToolDefaultsV1): ActiveShapeIconState {
  return {
    arrowStart: defaults.arrow.startNode,
    arrowEnd: defaults.arrow.endNode,
    coordinateDimension: defaults.coordinateSystem.dimension,
  };
}

function neutralStyleIcon(): ToolbarStyleIconState {
  return { fillColor: null, fillOpacity: 0, outlineColor: null, outlineStyle: "solid" };
}

export function createSelectionStyleReplacement(
  elements: readonly InkElementV1[],
  controlId: string,
  value: boolean | number | string,
): SelectionStyleReplacement | null {
  const steps = createSelectionStyleReplacementSteps(elements, controlId, value);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value === null ? null : { ...step.value, previous: elements };
}

/** The caller controls admission between individual selected records. */
export function* createSelectionStyleReplacementSteps(
  elements: Iterable<InkElementV1>,
  controlId: string,
  value: boolean | number | string,
): Generator<void, SelectionStyleReplacement | null> {
  const change = styleChange(controlId, value);
  const previous: InkElementV1[] = [];
  const replacements: InkElementV1[] = [];
  let changed = false;
  for (const element of elements) {
    const result = applySelectionStyleChange([element], change);
    previous.push(element);
    replacements.push(result.elements[0]!);
    changed ||= result.changed;
    yield;
  }
  if (previous.length === 0) applySelectionStyleChange([], change);
  return changed ? { previous, replacements } : null;
}

export function updateSessionToolDefaults(
  defaults: ToolDefaultsV1,
  tool: StartupToolV1,
  controlId: string,
  value: boolean | number | string,
): ToolDefaultsV1 {
  return applyToolStyleChange(defaults, tool, styleChange(controlId, value)).toolValues;
}

function selectionControls(summary: SelectionStyleSummary): readonly StyleControl[] {
  if (summary === null) return [];
  return summary.kind === "outline"
    ? outlineSelectionControls(summary)
    : strokeSelectionControls(summary);
}

function strokeSelectionControls(
  summary: Exclude<SelectionStyleSummary, OutlineSelectionStyleSummary | null>,
): readonly StyleControl[] {
  return [
    mixedChoiceControl("color", "Color", summary.color, COLOR_STYLE_OPTIONS, serializeStyleColor),
    mixedChoiceControl("stroke-width", "Width", summary.width, PEN_WIDTH_STYLE_OPTIONS, String),
    mixedNumberControl("opacity", "Opacity", summary.opacity, 0, 1, 0.05),
  ];
}

function outlineSelectionControls(summary: OutlineSelectionStyleSummary): readonly StyleControl[] {
  const controls: StyleControl[] = [
    mixedChoiceControl(
      "outline-color",
      "Outline color",
      summary.outlineColor,
      COLOR_STYLE_OPTIONS,
      serializeStyleColor,
    ),
    mixedChoiceControl(
      "outline-width",
      "Outline width",
      summary.outlineWidth,
      OUTLINE_WIDTH_STYLE_OPTIONS,
      String,
    ),
    mixedChoiceControl(
      "outline-style",
      "Outline style",
      summary.outlineStyle,
      OUTLINE_STYLE_OPTIONS,
      String,
    ),
    mixedNumberControl("outline-opacity", "Outline opacity", summary.outlineOpacity, 0, 1, 0.05),
  ];
  if (summary.fill !== null) {
    controls.push(
      mixedChoiceControl(
        "fill-color",
        "Fill color",
        summary.fill.color,
        FILL_COLOR_STYLE_OPTIONS,
        serializeNullableStyleColor,
      ),
      mixedNumberControl("fill-opacity", "Fill opacity", summary.fill.opacity, 0, 1, 0.05),
    );
  }
  if (summary.arrowNodes !== null) {
    controls.push(
      mixedChoiceControl(
        "arrow-start-node",
        "Start node",
        summary.arrowNodes.start,
        ARROW_NODE_STYLE_OPTIONS,
        String,
      ),
      mixedChoiceControl(
        "arrow-end-node",
        "End node",
        summary.arrowNodes.end,
        ARROW_NODE_STYLE_OPTIONS,
        String,
      ),
    );
  }
  controls.push(...structuralControls(summary.structural));
  return controls;
}

function structuralControls(
  structural: Exclude<OutlineSelectionStyleSummary["structural"], null> | null,
): readonly StyleControl[] {
  if (structural?.kind === "coordinate-system") {
    return createStructuralStyleControls({
      coordinateDimension: structural.dimension === "mixed" ? null : structural.dimension,
    });
  }
  if (structural?.kind === "table") {
    return createStructuralStyleControls({
      tableColumns: structural.columns === "mixed" ? null : structural.columns,
    });
  }
  return [];
}

function mixedChoiceControl<T>(
  id: string,
  label: string,
  value: T | "mixed",
  options: readonly StyleChoiceOption[],
  serialize: (value: T) => string,
): StyleControl {
  return {
    id,
    kind: "choice",
    label,
    mixed: value === "mixed",
    options,
    value: value === "mixed" ? null : serialize(value),
  };
}

function mixedNumberControl(
  id: string,
  label: string,
  value: number | "mixed",
  min: number,
  max: number,
  step: number,
): StyleControl {
  return {
    id,
    kind: "number",
    label,
    max,
    min,
    mixed: value === "mixed",
    step,
    value: value === "mixed" ? null : value,
  };
}

function styleChange(controlId: string, value: boolean | number | string): StyleChange {
  switch (controlId) {
    case "selection-area":
      return { property: controlId, value: parseSelectionArea(value) };
    case "selection-inclusion":
      return { property: controlId, value: parseSelectionInclusion(value) };
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
      return { property: controlId, value: requireBoolean(value, controlId) };
    case "outline-style":
      return { property: controlId, value: parseOutlineStyle(value) };
    case "arrow-start-node":
    case "arrow-end-node":
      return { property: controlId, value: parseArrowNode(value) };
    case "coordinate-dimension":
      return { property: controlId, value: parseDimension(value) };
    case "table-columns":
      return { property: controlId, value: requireNumber(value, controlId) };
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
