import {
  type ArrowNodeV1,
  type ColorV1,
  type InkElementV1,
  type OutlineStyleV1,
  type ShapeStyleV1,
  type StrokeStyleV1,
} from "../../../domain/schema/public";
import { BUILT_IN_COLORS } from "../../../domain/settings/defaults";
import {
  ARROW_NODES,
  OUTLINE_STYLES,
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
  type ActiveToolStyleSummary,
  type OutlineSelectionStyleSummary,
  type SelectionStyleSummary,
  type StrokeSelectionStyleSummary,
  type StyleChange,
} from "../../../editor/tools/public";
import {
  createStructuralStyleControls,
  type StyleChoiceOption,
  type StyleControl,
  type ToolbarStyleIconState,
} from "../../../rendering/ui/index";

const COLOR_LABELS = [
  "Theme text color",
  "Red",
  "Orange",
  "Yellow",
  "Green",
  "Cyan",
  "Blue",
  "Violet",
  "Pink",
] as const;

const COLOR_OPTIONS: readonly StyleChoiceOption[] = BUILT_IN_COLORS.map((color, index) => ({
  label: COLOR_LABELS[index] ?? colorValue(color),
  value: colorValue(color),
}));

const FILL_COLOR_OPTIONS: readonly StyleChoiceOption[] = [
  { label: "None", value: "none" },
  ...COLOR_OPTIONS,
];

const PEN_WIDTH_OPTIONS: readonly StyleChoiceOption[] = PEN_WIDTHS.map((width, index) => ({
  label: ["XS", "S", "M", "L", "XL"][index] ?? String(width),
  value: String(width),
}));

const OUTLINE_WIDTH_OPTIONS: readonly StyleChoiceOption[] = OUTLINE_WIDTHS.map((width, index) => ({
  label: ["S", "M", "L", "XL"][index] ?? String(width),
  value: String(width),
}));

const OUTLINE_STYLE_OPTIONS: readonly StyleChoiceOption[] = OUTLINE_STYLES.map((style) => ({
  label: `${style[0]?.toUpperCase() ?? ""}${style.slice(1)}`,
  value: style,
}));

const ARROW_NODE_OPTIONS: readonly StyleChoiceOption[] = ARROW_NODES.map((node) => ({
  label: `${node[0]?.toUpperCase() ?? ""}${node.slice(1)}`,
  value: node,
}));

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
  return activeToolControls(summarizeActiveToolStyle(context.defaults, context.tool));
}

export function createActiveEditorStyleIcon(
  defaults: ToolDefaultsV1,
  tool: StartupToolV1,
): ToolbarStyleIconState {
  const summary = summarizeActiveToolStyle(defaults, tool);
  if (summary === null || summary.kind === "eraser") return neutralStyleIcon();
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

function neutralStyleIcon(): ToolbarStyleIconState {
  return { fillColor: null, fillOpacity: 0, outlineColor: null, outlineStyle: "solid" };
}

export function createSelectionStyleReplacement(
  elements: readonly InkElementV1[],
  controlId: string,
  value: boolean | number | string,
): SelectionStyleReplacement | null {
  const result = applySelectionStyleChange(elements, styleChange(controlId, value));
  return result.changed ? { previous: elements, replacements: result.elements } : null;
}

export function updateSessionToolDefaults(
  defaults: ToolDefaultsV1,
  tool: StartupToolV1,
  controlId: string,
  value: boolean | number | string,
): ToolDefaultsV1 {
  return applyToolStyleChange(defaults, tool, styleChange(controlId, value)).toolValues;
}

function activeToolControls(summary: ActiveToolStyleSummary): readonly StyleControl[] {
  if (summary === null) return [];
  if (summary.kind === "eraser")
    return [numberControl("eraser-radius", "Eraser radius", summary.radius, 8, 64, 4)];
  if (summary.kind === "stroke") {
    const controls = strokeControls(summary.color, summary.width, summary.opacity);
    return summary.pressureEnabled === null
      ? controls
      : [
          ...controls,
          {
            checked: summary.pressureEnabled,
            id: "pressure-enabled",
            kind: "toggle",
            label: "Pressure sensitivity",
          },
        ];
  }
  return outlineControls(summary);
}

function selectionControls(summary: SelectionStyleSummary): readonly StyleControl[] {
  if (summary === null) return [];
  return summary.kind === "stroke"
    ? strokeSelectionControls(summary)
    : outlineSelectionControls(summary);
}

function strokeControls(
  color: ColorV1,
  width: StrokeStyleV1["width"],
  opacity: number,
): readonly StyleControl[] {
  return [
    choiceControl("color", "Color", colorValue(color), COLOR_OPTIONS),
    choiceControl("stroke-width", "Width", String(width), PEN_WIDTH_OPTIONS),
    numberControl("opacity", "Opacity", opacity, 0, 1, 0.05),
  ];
}

function strokeSelectionControls(summary: StrokeSelectionStyleSummary): readonly StyleControl[] {
  return [
    mixedChoiceControl("color", "Color", summary.color, COLOR_OPTIONS, colorValue),
    mixedChoiceControl("stroke-width", "Width", summary.width, PEN_WIDTH_OPTIONS, String),
    mixedNumberControl("opacity", "Opacity", summary.opacity, 0, 1, 0.05),
  ];
}

function outlineControls(
  summary: Extract<ActiveToolStyleSummary, { readonly kind: "outline" }>,
): readonly StyleControl[] {
  const controls: StyleControl[] = [...outlinePaintControls(summary.style)];
  if (summary.fill !== null) {
    controls.push(
      choiceControl(
        "fill-color",
        "Fill color",
        nullableColorValue(summary.fill.fillColor),
        FILL_COLOR_OPTIONS,
      ),
      numberControl("fill-opacity", "Fill opacity", summary.fill.fillOpacity, 0, 1, 0.05),
    );
  }
  if (summary.arrowNodes !== null) controls.push(...arrowControls(summary.arrowNodes));
  controls.push(...structuralControls(summary.structural));
  return controls;
}

function outlineSelectionControls(summary: OutlineSelectionStyleSummary): readonly StyleControl[] {
  const controls: StyleControl[] = [
    mixedChoiceControl(
      "outline-color",
      "Outline color",
      summary.outlineColor,
      COLOR_OPTIONS,
      colorValue,
    ),
    mixedChoiceControl(
      "outline-width",
      "Outline width",
      summary.outlineWidth,
      OUTLINE_WIDTH_OPTIONS,
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
        FILL_COLOR_OPTIONS,
        nullableColorValue,
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
        ARROW_NODE_OPTIONS,
        String,
      ),
      mixedChoiceControl(
        "arrow-end-node",
        "End node",
        summary.arrowNodes.end,
        ARROW_NODE_OPTIONS,
        String,
      ),
    );
  }
  controls.push(...structuralControls(summary.structural));
  return controls;
}

function outlinePaintControls(style: OutlineStyleV1): readonly StyleControl[] {
  return [
    choiceControl("outline-color", "Outline color", colorValue(style.outlineColor), COLOR_OPTIONS),
    choiceControl(
      "outline-width",
      "Outline width",
      String(style.outlineWidth),
      OUTLINE_WIDTH_OPTIONS,
    ),
    choiceControl("outline-style", "Outline style", style.outlineStyle, OUTLINE_STYLE_OPTIONS),
    numberControl("outline-opacity", "Outline opacity", style.outlineOpacity, 0, 1, 0.05),
  ];
}

function arrowControls(nodes: { readonly start: ArrowNodeV1; readonly end: ArrowNodeV1 }) {
  return [
    choiceControl("arrow-start-node", "Start node", nodes.start, ARROW_NODE_OPTIONS),
    choiceControl("arrow-end-node", "End node", nodes.end, ARROW_NODE_OPTIONS),
  ];
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

function choiceControl(
  id: string,
  label: string,
  value: string,
  options: readonly StyleChoiceOption[],
): StyleControl {
  return { id, kind: "choice", label, options, value };
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

function numberControl(
  id: string,
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
): StyleControl {
  return { id, kind: "number", label, max, min, step, value };
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

function colorValue(color: ColorV1): string {
  return color.type === "theme-text" ? "theme-text" : color.value;
}

function nullableColorValue(color: ShapeStyleV1["fillColor"]): string {
  return color === null ? "none" : colorValue(color);
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
  if (width === 2 || width === 4 || width === 8 || width === 14 || width === 22) return width;
  throw new RangeError("The stroke width is not an available style option.");
}

function parseOutlineWidth(value: boolean | number | string): OutlineStyleV1["outlineWidth"] {
  const width = typeof value === "string" ? Number(value) : value;
  if (width === 2 || width === 4 || width === 8 || width === 12) return width;
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
