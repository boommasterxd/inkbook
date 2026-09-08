import { normalizeStrokePaint } from "../../domain/geometry/pressure-paint";
import {
  buildElementPathParts,
  effectiveStrokeWidth,
  outlineDashPattern,
} from "../../domain/geometry/public";
import type {
  ColorV1,
  InkElementV1,
  OutlineStyleV1,
  ShapeStyleV1,
} from "../../domain/schema/public";
import { serializeSvgNumber, serializeSvgOpacity } from "../documents/svg-number";
import { DOCUMENT_PALETTE, type ThemeClass } from "../documents/svg-theme";

type AttributeValue = number | string;
type PathAttributes = Readonly<Record<string, AttributeValue | undefined>>;

export function serializeElementPaths(element: InkElementV1): string[] {
  const parts = buildElementPathParts(element);
  if (element.kind === "stroke" && element.style.pressureEnabled) {
    const paint = normalizeStrokePaint(element.style);
    const opaque = { ...element, style: { ...element.style, color: paint.color, opacity: 1 } };
    const paths = parts.map((part) => serializeStrokePart(opaque, part.d, "fill"));
    return [`<g opacity="${serializeSvgOpacity(paint.opacity)}">${paths.join("")}</g>`];
  }
  return parts.map((part) => {
    if (element.kind === "stroke" || element.kind === "straight-highlighter") {
      if (part.paint === "fill-and-stroke") {
        throw new Error("Stroke geometry cannot require fill and stroke paint.");
      }
      return serializeStrokePart(element, part.d, part.paint);
    }
    if (element.kind === "rectangle" || element.kind === "ellipse" || isPolygon(element)) {
      return serializeShapePart(element.style, part.d);
    }
    if (part.paint === "fill-and-stroke") {
      throw new Error("Outline-only geometry cannot require fill and stroke paint.");
    }
    return serializeOutlinePart(element.style, part.d, part.paint);
  });
}

export function serializePath(d: string, attributes: PathAttributes): string {
  const serialized = [`d="${d}"`];
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined) serialized.push(`${name}="${formatAttribute(value)}"`);
  }
  return `<path ${serialized.join(" ")}/>`;
}

export function serializedPathDataByteLength(pathMarkup: string): number {
  const prefix = '<path d="';
  let bytes = 0;
  let cursor = 0;
  while (cursor < pathMarkup.length) {
    const start = pathMarkup.indexOf(prefix, cursor);
    if (start < 0) break;
    const dataStart = start + prefix.length;
    const end = pathMarkup.indexOf('"', dataStart);
    if (end < 0) throw new Error("invalid-serialized-path-markup");
    bytes += end - dataStart;
    cursor = end + 1;
  }
  return bytes;
}

function serializeStrokePart(
  element: Extract<InkElementV1, { kind: "stroke" | "straight-highlighter" }>,
  d: string,
  paint: "fill" | "stroke",
): string {
  const style = element.style;
  if (paint === "fill") {
    const color = paintValue(style.color, "fill");
    return serializePath(d, {
      class: color.className,
      fill: color.value,
      "fill-opacity": nonDefaultOpacity(style.opacity),
    });
  }
  const color = paintValue(style.color, "stroke");
  const width = effectiveStrokeWidth(element);
  return serializePath(d, {
    class: color.className,
    fill: "none",
    stroke: color.value,
    "stroke-width": width,
    "stroke-opacity": nonDefaultOpacity(style.opacity),
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
}

function serializeShapePart(style: ShapeStyleV1, d: string): string {
  const outline = paintValue(style.outlineColor, "stroke");
  const fill = style.fillColor === null ? null : paintValue(style.fillColor, "fill");
  const className = shapeThemeClass(style);
  const dash = outlineDashPattern(style.outlineStyle, style.outlineWidth);
  return serializePath(d, {
    class: className,
    fill: fill?.value ?? "none",
    "fill-opacity": fill === null ? undefined : nonDefaultOpacity(style.fillOpacity),
    stroke: outline.value,
    "stroke-width": style.outlineWidth,
    "stroke-opacity": nonDefaultOpacity(style.outlineOpacity),
    "stroke-linecap": style.outlineStyle === "dotted" ? "round" : "butt",
    "stroke-linejoin": "round",
    "stroke-dasharray": dash?.join(" "),
  });
}

function serializeOutlinePart(style: OutlineStyleV1, d: string, paint: "fill" | "stroke"): string {
  const color = paintValue(style.outlineColor, paint);
  if (paint === "fill") {
    return serializePath(d, {
      class: color.className,
      fill: color.value,
      "fill-opacity": nonDefaultOpacity(style.outlineOpacity),
    });
  }
  const dash = outlineDashPattern(style.outlineStyle, style.outlineWidth);
  return serializePath(d, {
    class: color.className,
    fill: "none",
    stroke: color.value,
    "stroke-width": style.outlineWidth,
    "stroke-opacity": nonDefaultOpacity(style.outlineOpacity),
    "stroke-linecap": style.outlineStyle === "dotted" ? "round" : "butt",
    "stroke-linejoin": "round",
    "stroke-dasharray": dash?.join(" "),
  });
}

function paintValue(
  color: ColorV1,
  paint: "fill" | "stroke",
): {
  className?: ThemeClass;
  value: string;
} {
  if (color.type === "rgba") return { value: color.value };
  return {
    className: paint === "fill" ? "inkbook-theme-fill" : "inkbook-theme-stroke",
    value: DOCUMENT_PALETTE.light.text,
  };
}

function shapeThemeClass(style: ShapeStyleV1): ThemeClass | undefined {
  const outlineTheme = style.outlineColor.type === "theme-text";
  const fillTheme = style.fillColor?.type === "theme-text";
  if (outlineTheme && fillTheme) return "inkbook-theme-stroke-fill";
  if (outlineTheme) return "inkbook-theme-stroke";
  return fillTheme ? "inkbook-theme-fill" : undefined;
}

function formatAttribute(value: AttributeValue): string {
  if (typeof value === "string") return value;
  return serializePaintNumber(value);
}

function serializePaintNumber(value: number): string {
  return serializeSvgNumber(value);
}

function nonDefaultOpacity(value: number): string | undefined {
  return value === 1 ? undefined : serializeSvgOpacity(value);
}

function isPolygon(
  element: InkElementV1,
): element is Extract<
  InkElementV1,
  { kind: "diamond" | "octagon" | "parallelogram" | "triangle" }
> {
  return ["diamond", "octagon", "parallelogram", "triangle"].includes(element.kind);
}
