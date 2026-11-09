import { Localization, type Translator } from "../../domain/localization";
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

const COLOR_KEYS = [
  "theme-text",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "violet",
  "pink",
  "gray",
] as const;

export function colorStyleOptions(t: Translator): readonly StyleChoiceOption[] {
  return BUILT_IN_COLORS.map((color, index) => ({
    label: t(`editor.option.${COLOR_KEYS[index]!}`),
    value: serializeStyleColor(color),
  }));
}

export function fillColorStyleOptions(t: Translator): readonly StyleChoiceOption[] {
  return [{ label: t("editor.option.none"), value: "none" }, ...colorStyleOptions(t)];
}

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

export function outlineStyleOptions(t: Translator): readonly StyleChoiceOption[] {
  return OUTLINE_STYLES.map((style) => ({ label: t(`editor.option.${style}`), value: style }));
}

export function arrowNodeStyleOptions(t: Translator): readonly StyleChoiceOption[] {
  return ARROW_NODES.map((node) => ({ label: t(`editor.option.${node}`), value: node }));
}

export function createToolStyleControls(
  defaults: ToolDefaultsV1,
  tool: StartupToolV1,
  t: Translator = new Localization().t,
): readonly StyleControl[] {
  return controlsForSummary(summarizeActiveToolStyle(defaults, tool), t);
}

function controlsForSummary(
  summary: ActiveToolStyleSummary,
  t: Translator,
): readonly StyleControl[] {
  if (summary === null) return [];
  if (summary.kind === "select") return selectControls(summary.values, t);
  if (summary.kind === "eraser") {
    return [
      numberControl("eraser-radius", t("editor.control.eraser-radius"), summary.radius, 8, 64, 4),
    ];
  }
  if (summary.kind === "stroke") return strokeControls(summary, t);
  return outlineControls(summary, t);
}

function selectControls(values: ToolDefaultsV1["select"], t: Translator): readonly StyleControl[] {
  return [
    choiceControl("selection-area", t("editor.control.selection-area"), values.area, [
      { label: t("editor.shape.rectangle"), value: "rectangle" },
      { label: t("editor.shape.lasso"), value: "lasso" },
    ]),
    choiceControl(
      "selection-inclusion",
      t("editor.control.selection-inclusion"),
      values.inclusion,
      [
        { label: t("editor.option.fully-enclosed"), value: "fully-enclosed" },
        { label: t("editor.option.touched"), value: "touched" },
      ],
    ),
  ];
}

function strokeControls(
  summary: Extract<ActiveToolStyleSummary, { readonly kind: "stroke" }>,
  t: Translator,
): readonly StyleControl[] {
  const controls: StyleControl[] = [
    choiceControl(
      "color",
      t("editor.control.color"),
      serializeStyleColor(summary.color),
      colorStyleOptions(t),
    ),
    choiceControl(
      "stroke-width",
      t("editor.control.stroke-width"),
      String(summary.width),
      PEN_WIDTH_STYLE_OPTIONS,
    ),
    numberControl("opacity", t("editor.control.opacity"), summary.opacity, 0, 1, 0.05),
  ];
  if (summary.pressureEnabled !== null) {
    controls.push({
      checked: summary.pressureEnabled,
      id: "pressure-enabled",
      kind: "toggle",
      label: t("editor.control.pressure-enabled"),
    });
  }
  if (summary.holdToShapeEnabled !== null) {
    controls.push({
      checked: summary.holdToShapeEnabled,
      id: "hold-to-shape-enabled",
      kind: "toggle",
      label: t("editor.control.hold-to-shape-enabled"),
    });
  }
  return controls;
}

function outlineControls(
  summary: Extract<ActiveToolStyleSummary, { readonly kind: "outline" }>,
  t: Translator,
): readonly StyleControl[] {
  const controls: StyleControl[] = [...outlinePaintControls(summary.style, t)];
  if (summary.fill !== null) {
    controls.push(
      choiceControl(
        "fill-color",
        t("editor.control.fill-color"),
        serializeNullableStyleColor(summary.fill.fillColor),
        fillColorStyleOptions(t),
      ),
      numberControl(
        "fill-opacity",
        t("editor.control.fill-opacity"),
        summary.fill.fillOpacity,
        0,
        1,
        0.05,
      ),
    );
  }
  if (summary.arrowNodes !== null) controls.push(...arrowControls(summary.arrowNodes, t));
  if (summary.structural?.kind === "coordinate-system") {
    controls.push(
      ...createStructuralStyleControls({ coordinateDimension: summary.structural.dimension }, t),
    );
  }
  if (summary.structural?.kind === "table") {
    controls.push(
      ...createStructuralStyleControls({ tableColumns: summary.structural.columns }, t),
    );
  }
  if (summary.snappingEnabled !== null) {
    controls.push({
      checked: summary.snappingEnabled,
      id: "snapping-enabled",
      kind: "toggle",
      label: t("editor.control.snapping-enabled"),
    });
  }
  return controls;
}

function outlinePaintControls(style: OutlineStyleV1, t: Translator): readonly StyleControl[] {
  return [
    choiceControl(
      "outline-color",
      t("editor.control.outline-color"),
      serializeStyleColor(style.outlineColor),
      colorStyleOptions(t),
    ),
    choiceControl(
      "outline-width",
      t("editor.control.outline-width"),
      String(style.outlineWidth),
      OUTLINE_WIDTH_STYLE_OPTIONS,
    ),
    choiceControl(
      "outline-style",
      t("editor.control.outline-style"),
      style.outlineStyle,
      outlineStyleOptions(t),
    ),
    numberControl(
      "outline-opacity",
      t("editor.control.outline-opacity"),
      style.outlineOpacity,
      0,
      1,
      0.05,
    ),
  ];
}

function arrowControls(
  nodes: { readonly start: ArrowNodeV1; readonly end: ArrowNodeV1 },
  t: Translator,
) {
  return [
    choiceControl(
      "arrow-start-node",
      t("editor.control.arrow-start-node"),
      nodes.start,
      arrowNodeStyleOptions(t),
    ),
    choiceControl(
      "arrow-end-node",
      t("editor.control.arrow-end-node"),
      nodes.end,
      arrowNodeStyleOptions(t),
    ),
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
