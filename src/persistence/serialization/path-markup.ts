import { strokeLocalGeometry } from "../../domain/geometry/stroke-position";
import { isPointElement, type SvgPathPart } from "../../domain/geometry/element-path";
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
  return serializeParts(
    element,
    buildElementPathParts(element.kind === "stroke" ? strokeLocalGeometry(element) : element),
  );
}

export function serializeParts(element: InkElementV1, parts: readonly SvgPathPart[]): string[] {
  if (element.kind === "stroke" && element.style.pressureEnabled) {
    const paint = normalizeStrokePaint(element.style);
    const opaque = { ...element, style: { ...element.style, color: paint.color, opacity: 1 } };
    const paths = parts.map((part) => serializeStrokePart(opaque, part.d, "fill"));
    return [
      `<g opacity="${serializeSvgOpacity(paint.opacity)}"${strokeTranslationAttribute(element)}>${paths.join("")}</g>`,
    ];
  }
  const paths = parts.map((part) => {
    if (element.kind === "stroke" || element.kind === "straight-highlighter") {
      if (part.paint === "fill-and-stroke") {
        throw new Error("Stroke geometry cannot require fill and stroke paint.");
      }
      return serializeStrokePart(element, part.d, part.paint);
    }
    if (element.kind === "rectangle" || element.kind === "ellipse" || isPolygon(element)) {
      return serializeShapePart(element.style, part.d, isPointElement(element));
    }
    if (part.paint === "fill-and-stroke") {
      throw new Error("Outline-only geometry cannot require fill and stroke paint.");
    }
    return serializeOutlinePart(element.style, part.d, part.paint, isPointElement(element));
  });
  return element.kind === "stroke" && element.offset !== undefined
    ? [`<g${strokeTranslationAttribute(element)}>${paths.join("")}</g>`]
    : paths;
}

function strokeTranslationAttribute(element: Extract<InkElementV1, { kind: "stroke" }>): string {
  return element.offset === undefined
    ? ""
    : ` transform="translate(${serializeSvgNumber(element.offset.x)} ${serializeSvgNumber(element.offset.y)})"`;
}

export function serializePath(d: string, attributes: PathAttributes): string {
  const serialized = [`d="${d}"`];
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined) serialized.push(`${name}="${formatAttribute(value)}"`);
  }
  return `<path ${serialized.join(" ")}/>`;
}

/** Generated path markup is ASCII; optional offsets address its existing UTF-8 payload. */
export function serializedPathDataByteLength(pathMarkup: string, offsets?: number[]): number {
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
    offsets?.push(dataStart, end);
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

function serializeShapePart(style: ShapeStyleV1, d: string, point: boolean): string {
  const outline = paintValue(style.outlineColor, "stroke");
  const fill = style.fillColor === null ? null : paintValue(style.fillColor, "fill");
  const className = shapeThemeClass(style);
  return serializePath(d, {
    class: className,
    fill: fill?.value ?? "none",
    "fill-opacity": fill === null ? undefined : nonDefaultOpacity(style.fillOpacity),
    stroke: outline.value,
    ...outlineStrokeAttributes(style, point),
  });
}

function serializeOutlinePart(
  style: OutlineStyleV1,
  d: string,
  paint: "fill" | "stroke",
  point: boolean,
): string {
  const color = paintValue(style.outlineColor, paint);
  if (paint === "fill") {
    return serializePath(d, {
      class: color.className,
      fill: color.value,
      "fill-opacity": nonDefaultOpacity(style.outlineOpacity),
    });
  }
  return serializePath(d, {
    class: color.className,
    fill: "none",
    stroke: color.value,
    ...outlineStrokeAttributes(style, point),
  });
}

function outlineStrokeAttributes(style: OutlineStyleV1, point: boolean): PathAttributes {
  const dash = point ? null : outlineDashPattern(style.outlineStyle, style.outlineWidth);
  return {
    "stroke-width": style.outlineWidth,
    "stroke-opacity": nonDefaultOpacity(style.outlineOpacity),
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "stroke-dasharray": dash?.join(" "),
  };
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
