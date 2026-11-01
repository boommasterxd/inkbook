import type {
  ArrowNodeV1,
  ColorV1,
  OutlineStyleV1,
  ShapeStyleV1,
  StrokeStyleV1,
} from "../../../domain/schema/types";
import { PEN_WIDTHS } from "../../../domain/settings/types";
import { nearest, sourceColor } from "./source-style";
import { optionalNumber, text, unit, unsupported, type SourceRecord } from "./source-values";

const COLORS: Readonly<Record<string, string>> = {
  grey: "#9FA8B2",
  "light-violet": "#E085F4",
  violet: "#AE3EC9",
  blue: "#4465E9",
  "light-blue": "#4BA1F1",
  yellow: "#F1AC4B",
  orange: "#E16919",
  green: "#099268",
  "light-green": "#4CB05E",
  "light-red": "#F87777",
  red: "#E03131",
  white: "#FFFFFF",
};

const SEMI_COLORS: Readonly<Record<string, string>> = {
  black: "#E8E8E8",
  grey: "#ECEEF0",
  "light-violet": "#F5EAFA",
  violet: "#ECDCF2",
  blue: "#DCE1F8",
  "light-blue": "#DDEDFA",
  yellow: "#F9F0E6",
  orange: "#F8E2D4",
  green: "#D3E9E3",
  "light-green": "#DBF0E0",
  "light-red": "#F4DADB",
  red: "#F4DADB",
  white: "#F5F5F5",
};

const SIZES: Readonly<Record<string, number>> = { s: 2, m: 3.5, l: 5, xl: 10 };

function color(value: unknown, warnings: Set<string>): ColorV1 {
  const name = text(value, "Tldraw color");
  if (name === "black") return { type: "theme-text" };
  if (COLORS[name] !== undefined) {
    warnings.add("Legacy palette colors were frozen to tldraw's light palette.");
    return sourceColor(COLORS[name], warnings);
  }
  return sourceColor(name, warnings);
}

function size(props: SourceRecord): number {
  const key = text(props.size, "Tldraw size");
  const width = SIZES[key];
  if (width === undefined) unsupported("Unsupported tldraw width preset.");
  const scale = optionalNumber(props.scale, 1, "Tldraw scale");
  if (scale <= 0) unsupported("Unsupported non-positive tldraw scale.");
  return width * scale;
}

export function tldrawStrokeStyle(
  props: SourceRecord,
  opacity: unknown,
  highlighter: boolean,
  warnings: Set<string>,
): StrokeStyleV1 {
  if (props.fill !== undefined && props.fill !== "none")
    unsupported("Filled freehand shapes cannot be imported faithfully.");
  if (props.dash !== undefined && props.dash !== "draw" && props.dash !== "solid") {
    unsupported("Dashed freehand strokes cannot be imported faithfully.");
  }
  warnings.add("Legacy stroke rendering uses Inkbook's native brush.");
  const width = highlighter ? size(props) * 8 : 1 + size(props) * 1.5;
  return {
    color: color(props.color, warnings),
    width: nearest(width, PEN_WIDTHS, warnings, "Stroke width"),
    opacity: unit(opacity, 1) * (highlighter ? 0.35 : 1),
    pressureEnabled: !highlighter,
    smoothing: 0.5,
  };
}

export function tldrawOutlineStyle(
  props: SourceRecord,
  opacity: unknown,
  warnings: Set<string>,
): OutlineStyleV1 {
  const dash = props.dash ?? "solid";
  if (typeof dash !== "string" || !["solid", "draw", "dashed", "dotted"].includes(dash))
    unsupported("Unsupported tldraw outline style.");
  if (dash === "draw")
    warnings.add("Hand-drawn shape outlines were converted to native solid outlines.");
  return {
    outlineColor: color(props.color, warnings),
    outlineWidth: nearest(
      size(props),
      [1, 2, 4, 8, 12, 14, 22] as const,
      warnings,
      "Outline width",
    ),
    outlineOpacity: unit(opacity, 1),
    outlineStyle: dash === "dashed" || dash === "dotted" ? dash : "solid",
  };
}

export function tldrawShapeStyle(
  props: SourceRecord,
  opacity: unknown,
  warnings: Set<string>,
): ShapeStyleV1 {
  const fill = props.fill ?? "none";
  if (typeof fill !== "string" || !["none", "solid", "semi", "pattern"].includes(fill))
    unsupported("Unsupported tldraw shape fill.");
  if (fill === "pattern") warnings.add("Pattern fills were converted to native solid fills.");
  return {
    ...tldrawOutlineStyle(props, opacity, warnings),
    fillColor:
      fill === "none"
        ? null
        : fill === "solid"
          ? color(props.color, warnings)
          : sourceColor(SEMI_COLORS[text(props.color, "Fill color")], warnings),
    fillOpacity: unit(opacity, 1),
  };
}

export function tldrawArrowNode(value: unknown): ArrowNodeV1 {
  const node = value ?? "none";
  if (node === "none" || node === "arrow" || node === "triangle" || node === "diamond") return node;
  if (node === "dot") return "circle";
  return unsupported("Unsupported tldraw arrowhead.");
}
