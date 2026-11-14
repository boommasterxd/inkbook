import type { ColorV1, ShapeStyleV1 } from "../../domain/schema/public";
import type { Translator } from "../../domain/localization";
import { BUILT_IN_COLORS } from "../../domain/settings/defaults";
import type { StyleChoiceOption } from "./editor-menu-types";

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
  return [
    { label: t("editor.option.none"), value: "none" },
    ...colorStyleOptions(t).filter((_, index) => COLOR_KEYS[index] !== "gray"),
  ];
}

export function serializeStyleColor(color: ColorV1): string {
  return color.type === "theme-text" ? "theme-text" : color.value;
}

export function serializeNullableStyleColor(color: ShapeStyleV1["fillColor"]): string {
  return color === null ? "none" : serializeStyleColor(color);
}
