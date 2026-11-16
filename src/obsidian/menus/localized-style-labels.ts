import { editor } from "../../domain/localization/locales/en/editor";
import { BUILT_IN_COLOR_OPTIONS } from "../../domain/settings/color-palette";
import type { MessageKey } from "../../domain/localization";
import type { StyleControl, StyleChoiceOption } from "./editor-menu-types";
import { menuTranslator } from "./localized-menu-text";
import type { MenuLocalizationOptions as StyleMenuContentOptions } from "./localized-menu-text";

export function controlLabel(options: StyleMenuContentOptions, control: StyleControl): string {
  const key = `editor.control.${control.id}`;
  return (options.localization === undefined && options.t === undefined) || !(key in editor)
    ? control.label
    : menuTranslator(options)(key as MessageKey);
}

export function choiceLabel(
  options: StyleMenuContentOptions,
  id: string,
  option: StyleChoiceOption,
): string {
  if (options.localization === undefined && options.t === undefined) return option.label;
  if (id.endsWith("width") || id === "text-font-family") return option.label;
  const key =
    id === "selection-area" ? `editor.shape.${option.value}` : `editor.option.${option.value}`;
  if (id.endsWith("color") && option.value.startsWith("#")) {
    const color = BUILT_IN_COLOR_OPTIONS.find(
      ({ color }) => color.type === "rgba" && color.value === option.value,
    );
    return color === undefined
      ? option.label
      : menuTranslator(options)(`editor.option.${color.key}`);
  }
  return menuTranslator(options)(key as MessageKey);
}
