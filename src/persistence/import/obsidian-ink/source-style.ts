import type { ObsidianInkWarningCode } from "./warnings";
import type {
  BackgroundV1,
  ColorV1,
  OutlineStyleV1,
  StrokeStyleV1,
} from "../../../domain/schema/types";
import { LINE_SPACINGS, PEN_WIDTHS } from "../../../domain/settings/types";
import {
  finite,
  optionalNumber,
  invalid,
  text,
  unit,
  unsupported,
  type SourceRecord,
} from "./source-values";

const PALETTE: Readonly<Record<string, string>> = {
  red: "#E93147",
  orange: "#EC7500",
  yellow: "#E0AC00",
  green: "#08B94E",
  cyan: "#00BFBC",
  blue: "#086DDD",
  purple: "#7852EE",
  pink: "#D53984",
};

export function nearest<T extends number>(
  value: number,
  presets: readonly T[],
  warnings: Set<ObsidianInkWarningCode>,
  label: "strokeWidth" | "outlineWidth" | "backgroundSpacing",
): T {
  if (value <= 0) invalid(`${label} must be positive.`);
  let result = presets[0]!;
  for (const preset of presets) {
    if (Math.abs(preset - value) < Math.abs(result - value)) result = preset;
  }
  if (result !== value) warnings.add(`${label}Preset`);
  return result;
}

export function sourceColor(value: unknown, warnings: Set<ObsidianInkWarningCode>): ColorV1 {
  const color = text(value, "Color");
  if (color === "currentColor" || color === "var(--text-normal)") return { type: "theme-text" };
  const variable = /^var\(--color-([a-z]+)\)$/u.exec(color);
  if (variable !== null && PALETTE[variable[1]!] !== undefined) {
    warnings.add("paletteFrozen");
    return sourceColor(PALETTE[variable[1]!]!, warnings);
  }
  const hex = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;
  if (!hex.test(color)) return cssColor(color, warnings);
  let digits = color.slice(1).toUpperCase();
  if (digits.length <= 4) digits = [...digits].map((digit) => digit + digit).join("");
  if (digits.length === 6) digits += "FF";
  return { type: "rgba", value: `#${digits}` };
}

function cssColor(color: string, warnings: Set<ObsidianInkWarningCode>): ColorV1 {
  const names: Readonly<Record<string, string>> = {
    black: "#000000",
    white: "#FFFFFF",
    transparent: "#00000000",
  };
  const named = names[color.toLowerCase()];
  if (named !== undefined) return sourceColor(named, warnings);
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(0?\.\d+|[01]))?\s*\)$/iu.exec(
    color,
  );
  if (rgb === null) unsupported("The source contains an unsupported color expression.");
  const channels = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  if (channels.some((channel) => channel > 255)) unsupported("Unsupported RGB color channel.");
  channels.push(Math.round(unit(rgb[4] === undefined ? undefined : Number(rgb[4]), 1) * 255));
  return sourceColor(
    `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`,
    warnings,
  );
}

export function strokeStyle(
  style: SourceRecord,
  warnings: Set<ObsidianInkWarningCode>,
  targetWidth?: StrokeStyleV1["width"],
): StrokeStyleV1 {
  const thinning = optionalNumber(style.thinning, 0.5, "Thinning");
  warnings.add("nativeBrush");
  return {
    color: sourceColor(style.color, warnings),
    width:
      targetWidth ??
      nearest(finite(style.size, "Stroke width"), PEN_WIDTHS, warnings, "strokeWidth"),
    opacity: unit(style.opacity, 1),
    pressureEnabled: style.brush !== "highlighter" && thinning !== 0,
    smoothing: 0.5,
  };
}

export function outlineStyle(
  style: SourceRecord,
  warnings: Set<ObsidianInkWarningCode>,
): OutlineStyleV1 {
  const dash = style.dash ?? "solid";
  if (dash !== "solid" && dash !== "dashed" && dash !== "dotted")
    unsupported("Unsupported shape dash.");
  return {
    outlineColor: sourceColor(style.strokeColor, warnings),
    outlineWidth: nearest(
      finite(style.strokeWidth, "Outline width"),
      [1, 2, 4, 8, 12, 14, 22] as const,
      warnings,
      "outlineWidth",
    ),
    outlineOpacity: unit(style.opacity, 1),
    outlineStyle: dash,
  };
}

export function background(
  source: SourceRecord,
  warnings: Set<ObsidianInkWarningCode>,
): BackgroundV1 {
  const ruled = source.writingBackgroundStyle ?? "lines";
  if (ruled !== "lines" && ruled !== "none") unsupported("Unsupported writing background.");
  if (source.gridEnabled === true) {
    const type = source.gridStyle ?? "dots";
    if (type !== "dots" && type !== "squares") unsupported("Unsupported writing grid.");
    if (ruled === "lines") warnings.add("combinedBackground");
    return {
      type,
      spacing: nearest(
        optionalNumber(source.gridSize, 20, "Grid size"),
        LINE_SPACINGS,
        warnings,
        "backgroundSpacing",
      ),
    };
  }
  if (ruled === "none") return { type: "none" };
  return {
    type: "lines",
    spacing: nearest(
      optionalNumber(source.writingLineHeight, 150, "Line height"),
      LINE_SPACINGS,
      warnings,
      "backgroundSpacing",
    ),
  };
}
