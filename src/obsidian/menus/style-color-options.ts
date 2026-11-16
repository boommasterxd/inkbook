import type { ColorV1, ShapeStyleV1 } from "../../domain/schema/public";
import type { Translator } from "../../domain/localization";
import { BUILT_IN_COLOR_OPTIONS } from "../../domain/settings/color-palette";
import type { StyleChoiceOption } from "./editor-menu-types";

export function colorStyleOptions(t: Translator): readonly StyleChoiceOption[] {
  return BUILT_IN_COLOR_OPTIONS.map(({ color, key }) => ({
    label: t(`editor.option.${key}`),
    value: serializeStyleColor(color),
  }));
}

export function fillColorStyleOptions(t: Translator): readonly StyleChoiceOption[] {
  return [{ label: t("editor.option.none"), value: "none" }, ...colorStyleOptions(t)];
}

export function serializeStyleColor(color: ColorV1): string {
  return color.type === "theme-text" ? "theme-text" : color.value;
}

export function serializeNullableStyleColor(color: ShapeStyleV1["fillColor"]): string {
  return color === null ? "none" : serializeStyleColor(color);
}
