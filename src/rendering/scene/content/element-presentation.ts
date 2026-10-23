import { roundCanonical } from "../../../domain/geometry/public";
import { effectiveStrokeWidth } from "../../../domain/geometry/bounds";
import { normalizeStrokePaint } from "../../../domain/geometry/pressure/pressure-paint";
import {
  isPointElement,
  outlineDashPattern,
  type SvgPathPart,
} from "../../../domain/geometry/element-path";
import type {
  ColorV1,
  InkElementV1,
  OutlineStyleV1,
  StrokeElementV1,
  StrokeStyleV1,
} from "../../../domain/schema/public";

export type PresentationAttribute =
  | "class"
  | "fill"
  | "fill-opacity"
  | "fill-rule"
  | "stroke"
  | "stroke-dasharray"
  | "stroke-linecap"
  | "stroke-linejoin"
  | "stroke-opacity"
  | "stroke-width";

export type PathPresentation = Readonly<Record<PresentationAttribute, string | null>>;

export const PRESENTATION_ATTRIBUTES: readonly PresentationAttribute[] = [
  "class",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "stroke-width",
];

export function pathPresentation(element: InkElementV1, part: SvgPathPart): PathPresentation {
  if (element.kind === "stroke" || element.kind === "straight-highlighter") {
    const style =
      element.kind === "stroke" && element.style.pressureEnabled
        ? { ...element.style, color: normalizeStrokePaint(element.style).color, opacity: 1 }
        : element.style;
    return strokePresentation(style, part.paint, effectiveStrokeWidth(element));
  }
  const presentation = outlinePresentation(
    element.style,
    "fillColor" in element.style ? element.style.fillColor : null,
    "fillOpacity" in element.style ? element.style.fillOpacity : 1,
    part,
  );
  return isPointElement(element)
    ? { ...presentation, "stroke-linecap": "round", "stroke-dasharray": null }
    : presentation;
}

/** Conservative fixed-size paint reserve for snapshots that restore canonical widths. */
export function previewPaintPadding(element: InkElementV1): number {
  if (element.kind === "stroke" || element.kind === "straight-highlighter") {
    return effectiveStrokeWidth(element) / 2;
  }
  const width = element.style.outlineWidth;
  const nodeReserve =
    element.kind === "arrow" || element.kind === "coordinate-system" ? Math.max(12, width * 4) : 0;
  return width / 2 + nodeReserve;
}

export function liveStrokePresentation(
  style: StrokeStyleV1,
  paint: SvgPathPart["paint"],
  tool: StrokeElementV1["tool"],
): PathPresentation {
  const width = effectiveStrokeWidth({ kind: "stroke", style, tool });
  return strokePresentation(style, paint, width);
}

function strokePresentation(
  style: StrokeStyleV1,
  paint: SvgPathPart["paint"],
  width: number,
): PathPresentation {
  const fill = paint === "fill";
  const color = colorValue(style.color);
  return createPresentation({
    className: themeClass(style.color, fill ? "fill" : "stroke"),
    fill: fill ? color : "none",
    fillOpacity: fill ? style.opacity : null,
    fillRule: fill ? "nonzero" : null,
    lineCap: fill ? null : "round",
    lineJoin: fill ? null : "round",
    stroke: fill ? "none" : color,
    strokeOpacity: fill ? null : style.opacity,
    strokeWidth: fill ? null : width,
  });
}

function outlinePresentation(
  style: OutlineStyleV1,
  fillColor: ColorV1 | null,
  fillOpacity: number,
  part: SvgPathPart,
): PathPresentation {
  const usesStroke = part.paint !== "fill";
  const effectiveFillColor = part.paint === "fill" ? style.outlineColor : fillColor;
  const effectiveFillOpacity = part.paint === "fill" ? style.outlineOpacity : fillOpacity;
  const usesFill = part.paint !== "stroke" && effectiveFillColor !== null;
  const strokeColor = colorValue(style.outlineColor);
  const fill = effectiveFillColor === null ? "none" : colorValue(effectiveFillColor);
  const className = combinedThemeClass(
    usesStroke ? style.outlineColor : null,
    usesFill ? effectiveFillColor : null,
  );
  const dash = outlineDashPattern(style.outlineStyle, style.outlineWidth);
  return createPresentation({
    className,
    dash: usesStroke && dash !== null ? dash.join(" ") : null,
    fill: usesFill ? fill : "none",
    fillOpacity: usesFill ? effectiveFillOpacity : null,
    fillRule: part.paint === "stroke" ? null : "nonzero",
    lineCap: usesStroke ? "round" : null,
    lineJoin: usesStroke ? "round" : null,
    stroke: usesStroke ? strokeColor : "none",
    strokeOpacity: usesStroke ? style.outlineOpacity : null,
    strokeWidth: usesStroke ? style.outlineWidth : null,
  });
}

interface PresentationValues {
  readonly className: string | null;
  readonly dash?: string | null;
  readonly fill: string;
  readonly fillOpacity: number | null;
  readonly fillRule: "nonzero" | null;
  readonly lineCap: string | null;
  readonly lineJoin: string | null;
  readonly stroke: string;
  readonly strokeOpacity: number | null;
  readonly strokeWidth: number | null;
}

function createPresentation(values: PresentationValues): PathPresentation {
  return {
    class: values.className,
    fill: values.fill,
    "fill-opacity": nullableNumber(values.fillOpacity),
    "fill-rule": values.fillRule,
    stroke: values.stroke,
    "stroke-dasharray": values.dash ?? null,
    "stroke-linecap": values.lineCap,
    "stroke-linejoin": values.lineJoin,
    "stroke-opacity": nullableNumber(values.strokeOpacity),
    "stroke-width": nullableNumber(values.strokeWidth),
  };
}

function colorValue(color: ColorV1): string {
  return color.type === "theme-text" ? "#222222FF" : color.value;
}

function themeClass(color: ColorV1, paint: "fill" | "stroke"): string | null {
  return color.type === "theme-text" ? `inkbook-theme-${paint}` : null;
}

function combinedThemeClass(stroke: ColorV1 | null, fill: ColorV1 | null): string | null {
  const themeStroke = stroke?.type === "theme-text";
  const themeFill = fill?.type === "theme-text";
  if (themeStroke && themeFill) return "inkbook-theme-stroke-fill";
  if (themeStroke) return "inkbook-theme-stroke";
  if (themeFill) return "inkbook-theme-fill";
  return null;
}

function nullableNumber(value: number | null): string | null {
  return value === null ? null : String(value);
}

export function scaledDashPattern(value: string | null, scale: number): string | null {
  return value === null
    ? null
    : value
        .split(" ")
        .map((part) => scaledStrokeWidth(part, scale))
        .join(" ");
}

export function scaledStrokeWidth(value: string | null, scale: number): string | null {
  return value === null ? null : String(roundCanonical(Number(value) * scale));
}
