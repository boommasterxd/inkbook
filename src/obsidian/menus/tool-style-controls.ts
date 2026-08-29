import type {
  ArrowNodeV1,
  ColorV1,
  OutlineStyleV1,
  ShapeStyleV1,
} from "../../domain/schema/public";
import { BUILT_IN_COLORS } from "../../domain/settings/defaults";
import {
  ARROW_NODES,
  OUTLINE_STYLES,
  OUTLINE_WIDTHS,
  PEN_WIDTHS,
  type StartupToolV1,
  type ToolDefaultsV1,
} from "../../domain/settings/types";
import { summarizeActiveToolStyle, type ActiveToolStyleSummary } from "../../editor/tools/public";
import type { StyleChoiceOption, StyleControl } from "./editor-menu-types";
import { createStructuralStyleControls } from "./structural-style-controls";

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
  "Gray",
] as const;

export const COLOR_STYLE_OPTIONS: readonly StyleChoiceOption[] = BUILT_IN_COLORS.map(
  (color, index) => ({
    label: COLOR_LABELS[index] ?? serializeStyleColor(color),
    value: serializeStyleColor(color),
  }),
);

export const FILL_COLOR_STYLE_OPTIONS: readonly StyleChoiceOption[] = [
  { label: "None", value: "none" },
  ...COLOR_STYLE_OPTIONS,
];

export const PEN_WIDTH_STYLE_OPTIONS: readonly StyleChoiceOption[] = PEN_WIDTHS.map(
  (width, index) => ({
    label: ["XS", "S", "M", "L", "XL"][index] ?? String(width),
    value: String(width),
  }),
);

export const OUTLINE_WIDTH_STYLE_OPTIONS: readonly StyleChoiceOption[] = OUTLINE_WIDTHS.map(
  (width, index) => ({
    label: ["XS", "S", "M", "L", "XL"][index] ?? String(width),
    value: String(width),
  }),
);

export const OUTLINE_STYLE_OPTIONS: readonly StyleChoiceOption[] = OUTLINE_STYLES.map((style) => ({
  label: `${style[0]?.toUpperCase() ?? ""}${style.slice(1)}`,
  value: style,
}));

export const ARROW_NODE_STYLE_OPTIONS: readonly StyleChoiceOption[] = ARROW_NODES.map((node) => ({
  label: `${node[0]?.toUpperCase() ?? ""}${node.slice(1)}`,
  value: node,
}));

export function createToolStyleControls(
  defaults: ToolDefaultsV1,
  tool: StartupToolV1,
): readonly StyleControl[] {
  return controlsForSummary(summarizeActiveToolStyle(defaults, tool));
}

function controlsForSummary(summary: ActiveToolStyleSummary): readonly StyleControl[] {
  if (summary === null) return [];
  if (summary.kind === "eraser") {
    return [numberControl("eraser-radius", "Eraser radius", summary.radius, 8, 64, 4)];
  }
  if (summary.kind === "stroke") return strokeControls(summary);
  return outlineControls(summary);
}

function strokeControls(
  summary: Extract<ActiveToolStyleSummary, { readonly kind: "stroke" }>,
): readonly StyleControl[] {
  const controls: StyleControl[] = [
    choiceControl("color", "Color", serializeStyleColor(summary.color), COLOR_STYLE_OPTIONS),
    choiceControl("stroke-width", "Width", String(summary.width), PEN_WIDTH_STYLE_OPTIONS),
    numberControl("opacity", "Opacity", summary.opacity, 0, 1, 0.05),
  ];
  if (summary.pressureEnabled !== null) {
    controls.push({
      checked: summary.pressureEnabled,
      id: "pressure-enabled",
      kind: "toggle",
      label: "Pressure sensitivity",
    });
  }
  return controls;
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
        serializeNullableStyleColor(summary.fill.fillColor),
        FILL_COLOR_STYLE_OPTIONS,
      ),
      numberControl("fill-opacity", "Fill opacity", summary.fill.fillOpacity, 0, 1, 0.05),
    );
  }
  if (summary.arrowNodes !== null) controls.push(...arrowControls(summary.arrowNodes));
  if (summary.structural?.kind === "coordinate-system") {
    controls.push(
      ...createStructuralStyleControls({ coordinateDimension: summary.structural.dimension }),
    );
  }
  if (summary.structural?.kind === "table") {
    controls.push(...createStructuralStyleControls({ tableColumns: summary.structural.columns }));
  }
  return controls;
}

function outlinePaintControls(style: OutlineStyleV1): readonly StyleControl[] {
  return [
    choiceControl(
      "outline-color",
      "Outline color",
      serializeStyleColor(style.outlineColor),
      COLOR_STYLE_OPTIONS,
    ),
    choiceControl(
      "outline-width",
      "Outline width",
      String(style.outlineWidth),
      OUTLINE_WIDTH_STYLE_OPTIONS,
    ),
    choiceControl("outline-style", "Outline style", style.outlineStyle, OUTLINE_STYLE_OPTIONS),
    numberControl("outline-opacity", "Outline opacity", style.outlineOpacity, 0, 1, 0.05),
  ];
}

function arrowControls(nodes: { readonly start: ArrowNodeV1; readonly end: ArrowNodeV1 }) {
  return [
    choiceControl("arrow-start-node", "Start node", nodes.start, ARROW_NODE_STYLE_OPTIONS),
    choiceControl("arrow-end-node", "End node", nodes.end, ARROW_NODE_STYLE_OPTIONS),
  ];
}

function choiceControl(
  id: string,
  label: string,
  value: string,
  options: readonly StyleChoiceOption[],
): StyleControl {
  return { id, kind: "choice", label, options, value };
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

export function serializeStyleColor(color: ColorV1): string {
  return color.type === "theme-text" ? "theme-text" : color.value;
}

export function serializeNullableStyleColor(color: ShapeStyleV1["fillColor"]): string {
  return color === null ? "none" : serializeStyleColor(color);
}
