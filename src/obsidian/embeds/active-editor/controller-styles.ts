import { styleChange } from "./controller-style-values";
import { textToolbarIcon } from "./text-toolbar-icon";
import { Localization, type Translator } from "../../../domain/localization";
import { type InkElementV1 } from "../../../domain/schema/public";
import { type StartupToolV1, type ToolDefaultsV1 } from "../../../domain/settings/types";
import {
  applySelectionStyleChange,
  applyToolStyleChange,
  summarizeActiveToolStyle,
  summarizeSelectionStyle,
  type OutlineSelectionStyleSummary,
  type SelectionStyleSummary,
} from "../../../editor/tools/public";
import type { ToolbarStyleIconState } from "../../../rendering/ui/index";
import type { ActiveShapeIconState } from "../../../rendering/ui/icon-ids";
import type { StyleChoiceOption, StyleControl } from "../../menus/editor-menu-types";
import { createStructuralStyleControls } from "../../menus/structural-style-controls";
import { createTextStyleControls } from "../../menus/text-style-controls";
import {
  arrowNodeStyleOptions,
  colorStyleOptions,
  createToolStyleControls,
  fillColorStyleOptions,
  outlineStyleOptions,
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
  t: Translator = new Localization().t,
  fontOptions?: readonly StyleChoiceOption[],
): readonly StyleControl[] {
  if (context.selection.length > 0) {
    const summary = summarizeSelectionStyle(context.selection);
    return summary?.kind === "text"
      ? createTextStyleControls(summary, t, fontOptions)
      : selectionControls(summary, t);
  }
  return createToolStyleControls(context.defaults, context.tool, t, fontOptions);
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
  if (summary.kind === "text") {
    return textToolbarIcon(summary.values);
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

function selectionControls(summary: SelectionStyleSummary, t: Translator): readonly StyleControl[] {
  if (summary === null) return [];
  if (summary.kind === "text") return createTextStyleControls(summary, t);
  return summary.kind === "outline"
    ? outlineSelectionControls(summary, t)
    : strokeSelectionControls(summary, t);
}

function strokeSelectionControls(
  summary: Exclude<SelectionStyleSummary, OutlineSelectionStyleSummary | { kind: "text" } | null>,
  t: Translator,
): readonly StyleControl[] {
  const controls: StyleControl[] = [
    mixedChoiceControl(
      "color",
      t("editor.control.color"),
      summary.color,
      colorStyleOptions(t),
      serializeStyleColor,
    ),
    mixedNumberControl("opacity", t("editor.control.opacity"), summary.opacity, 0, 1, 0.05),
  ];
  if (summary.width !== null) {
    controls.splice(
      1,
      0,
      mixedChoiceControl(
        "stroke-width",
        t("editor.control.stroke-width"),
        summary.width,
        PEN_WIDTH_STYLE_OPTIONS,
        String,
      ),
    );
  }
  if (summary.kind === "common" && summary.fill != null) {
    controls.push(...fillSelectionControls(summary.fill, t));
  }
  return controls;
}

function outlineSelectionControls(
  summary: OutlineSelectionStyleSummary,
  t: Translator,
): readonly StyleControl[] {
  const controls: StyleControl[] = [
    mixedChoiceControl(
      "outline-color",
      t("editor.control.outline-color"),
      summary.outlineColor,
      colorStyleOptions(t),
      serializeStyleColor,
    ),
    mixedChoiceControl(
      "outline-width",
      t("editor.control.outline-width"),
      summary.outlineWidth,
      OUTLINE_WIDTH_STYLE_OPTIONS,
      String,
    ),
    mixedChoiceControl(
      "outline-style",
      t("editor.control.outline-style"),
      summary.outlineStyle,
      outlineStyleOptions(t),
      String,
    ),
    mixedNumberControl(
      "outline-opacity",
      t("editor.control.outline-opacity"),
      summary.outlineOpacity,
      0,
      1,
      0.05,
    ),
  ];
  if (summary.fill !== null) {
    controls.push(...fillSelectionControls(summary.fill, t));
  }
  if (summary.arrowNodes !== null) {
    controls.push(
      mixedChoiceControl(
        "arrow-start-node",
        t("editor.control.arrow-start-node"),
        summary.arrowNodes.start,
        arrowNodeStyleOptions(t),
        String,
      ),
      mixedChoiceControl(
        "arrow-end-node",
        t("editor.control.arrow-end-node"),
        summary.arrowNodes.end,
        arrowNodeStyleOptions(t),
        String,
      ),
    );
  }
  controls.push(...structuralControls(summary.structural, t));
  return controls;
}

function fillSelectionControls(
  fill: NonNullable<OutlineSelectionStyleSummary["fill"]>,
  t: Translator,
): readonly StyleControl[] {
  return [
    mixedChoiceControl(
      "fill-color",
      t("editor.control.fill-color"),
      fill.color,
      fillColorStyleOptions(t),
      serializeNullableStyleColor,
    ),
    mixedNumberControl("fill-opacity", t("editor.control.fill-opacity"), fill.opacity, 0, 1, 0.05),
  ];
}

function structuralControls(
  structural: Exclude<OutlineSelectionStyleSummary["structural"], null> | null,
  t: Translator,
): readonly StyleControl[] {
  if (structural?.kind === "coordinate-system") {
    return createStructuralStyleControls(
      {
        coordinateDimension: structural.dimension === "mixed" ? null : structural.dimension,
      },
      t,
    );
  }
  if (structural?.kind === "table") {
    return createStructuralStyleControls(
      {
        tableColumns: structural.columns === "mixed" ? null : structural.columns,
      },
      t,
    );
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
