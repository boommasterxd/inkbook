import { Localization, type Translator } from "../../domain/localization";
import type { TextDefaultsV2 } from "../../domain/settings/types";
import type { TextSelectionStyleSummary } from "../../editor/tools/text-style-summary";
import type { StyleChoiceOption, StyleControl } from "./editor-menu-types";
import {
  colorStyleOptions,
  fillColorStyleOptions,
  serializeNullableStyleColor,
  serializeStyleColor,
} from "./style-color-options";

export const BUILT_IN_TEXT_FONT_OPTIONS: readonly StyleChoiceOption[] = [
  { label: "Inter", value: "inter" },
  { label: "Source Serif 4", value: "source-serif" },
  { label: "Caveat", value: "caveat" },
  { label: "JetBrains Mono", value: "jetbrains-mono" },
];

export function createTextStyleControls(
  values: TextDefaultsV2 | TextSelectionStyleSummary,
  t: Translator = new Localization().t,
  fontOptions: readonly StyleChoiceOption[] = BUILT_IN_TEXT_FONT_OPTIONS,
): readonly StyleControl[] {
  const selected = "kind" in values;
  const style = selected ? values.style : values;
  const backgroundColor = values.backgroundColor;
  const alignment = values.alignment;
  const choices = (
    id: string,
    value: unknown,
    options: readonly StyleChoiceOption[],
    serialize: (value: never) => string = String,
  ): StyleControl => ({
    id,
    kind: "choice",
    label: t(`editor.control.${id}` as Parameters<Translator>[0]),
    mixed: value === "mixed",
    value: value === "mixed" ? null : serialize(value as never),
    options,
  });
  return [
    choices("color", style.color, colorStyleOptions(t), serializeStyleColor),
    {
      id: "opacity",
      kind: "number",
      label: t("editor.control.opacity"),
      min: 0,
      max: 1,
      step: 0.05,
      value: style.opacity === "mixed" ? null : style.opacity,
      mixed: style.opacity === "mixed",
    },
    choices("text-font-family", style.fontFamily, fontOptions),
    {
      id: "text-font-size",
      kind: "number",
      label: t("editor.control.text-font-size"),
      min: 1,
      max: 100,
      step: "any",
      value: style.fontSize === "mixed" ? null : style.fontSize,
      mixed: style.fontSize === "mixed",
    },
    ...(["bold", "italic", "underline", "strikethrough"] as const).map((key): StyleControl => ({
      id: `text-${key}`,
      kind: "toggle",
      presentation: "icon",
      label: t(`editor.control.text-${key}`),
      checked: style[key] === true,
      mixed: style[key] === "mixed",
    })),
    choices(
      "text-alignment",
      alignment,
      (["left", "center", "right", "justify"] as const).map((value) => ({
        value,
        label: t(`editor.option.${value}`),
      })),
    ),
    choices(
      "text-background-color",
      backgroundColor,
      fillColorStyleOptions(t),
      serializeNullableStyleColor,
    ),
    {
      id: "text-background-opacity",
      kind: "number",
      label: t("editor.control.text-background-opacity"),
      min: 0,
      max: 1,
      step: 0.05,
      value: values.backgroundOpacity === "mixed" ? null : values.backgroundOpacity,
      mixed: values.backgroundOpacity === "mixed",
    },
  ];
}
