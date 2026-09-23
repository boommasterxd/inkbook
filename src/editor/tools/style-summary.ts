import type {
  ArrowNodeV1,
  ColorV1,
  InkElementV1,
  OutlineStyleV1,
  ShapeStyleV1,
  StrokeStyleV1,
} from "../../domain/schema/public";
import type { StartupToolV1, ToolDefaultsV1 } from "../../domain/settings/types";
import {
  summarizeStructuralStyle,
  type MixedValue,
  type StructuralStyleSummary,
} from "../selection/structural-style";

export interface StrokeSelectionStyleSummary {
  readonly kind: "stroke";
  readonly color: MixedValue<ColorV1>;
  readonly width: MixedValue<StrokeStyleV1["width"]>;
  readonly opacity: MixedValue<number>;
  readonly pressureEnabled: MixedValue<boolean> | null;
}

export interface OutlineSelectionStyleSummary {
  readonly kind: "outline";
  readonly outlineColor: MixedValue<ColorV1>;
  readonly outlineWidth: MixedValue<OutlineStyleV1["outlineWidth"]>;
  readonly outlineStyle: MixedValue<OutlineStyleV1["outlineStyle"]>;
  readonly outlineOpacity: MixedValue<number>;
  readonly fill: {
    readonly color: MixedValue<ShapeStyleV1["fillColor"]>;
    readonly opacity: MixedValue<number>;
  } | null;
  readonly arrowNodes: {
    readonly start: MixedValue<ArrowNodeV1>;
    readonly end: MixedValue<ArrowNodeV1>;
  } | null;
  readonly structural: StructuralStyleSummary;
}

export type SelectionStyleSummary =
  | StrokeSelectionStyleSummary
  | OutlineSelectionStyleSummary
  | (Pick<StrokeSelectionStyleSummary, "color" | "opacity"> & {
      readonly kind: "common";
      readonly width: MixedValue<OutlineStyleV1["outlineWidth"]>;
    })
  | null;

export type ActiveToolStyleSummary =
  | { readonly kind: "select"; readonly values: ToolDefaultsV1["select"] }
  | { readonly kind: "eraser"; readonly radius: number }
  | {
      readonly kind: "stroke";
      readonly color: ColorV1;
      readonly width: StrokeStyleV1["width"];
      readonly opacity: number;
      readonly pressureEnabled: boolean | null;
    }
  | {
      readonly kind: "outline";
      readonly style: OutlineStyleV1;
      readonly fill: Pick<ShapeStyleV1, "fillColor" | "fillOpacity"> | null;
      readonly arrowNodes: { readonly start: ArrowNodeV1; readonly end: ArrowNodeV1 } | null;
      readonly structural:
        | { readonly kind: "coordinate-system"; readonly dimension: "2d" | "3d" }
        | { readonly kind: "table"; readonly columns: number }
        | null;
    }
  | null;

export function summarizeSelectionStyle(elements: readonly InkElementV1[]): SelectionStyleSummary {
  if (elements.length === 0) return null;
  if (elements.every(isStrokeStyled)) return summarizeStrokeSelection(elements);
  if (!elements.every(isOutlineStyled)) return summarizeCommonSelection(elements);

  const styles = elements.map(({ style }) => style);
  const closedStyles = elements.every(isClosedShape) ? elements.map(({ style }) => style) : null;
  const arrows = elements.every((element) => element.kind === "arrow") ? elements : null;
  return {
    kind: "outline",
    outlineColor: common(
      styles.map(({ outlineColor }) => outlineColor),
      equalColor,
    ),
    outlineWidth: common(styles.map(({ outlineWidth }) => outlineWidth)),
    outlineStyle: common(styles.map(({ outlineStyle }) => outlineStyle)),
    outlineOpacity: common(styles.map(({ outlineOpacity }) => outlineOpacity)),
    fill:
      closedStyles === null
        ? null
        : {
            color: common(
              closedStyles.map(({ fillColor }) => fillColor),
              equalNullableColor,
            ),
            opacity: common(closedStyles.map(({ fillOpacity }) => fillOpacity)),
          },
    arrowNodes:
      arrows === null
        ? null
        : {
            start: common(arrows.map(({ startNode }) => startNode)),
            end: common(arrows.map(({ endNode }) => endNode)),
          },
    structural: summarizeStructuralStyle(elements),
  };
}

export function summarizeActiveToolStyle(
  toolValues: ToolDefaultsV1,
  tool: StartupToolV1,
): ActiveToolStyleSummary {
  if (tool === "select") return { kind: "select", values: structuredClone(toolValues.select) };
  if (tool === "eraser") return { kind: "eraser", radius: toolValues.eraser.radius };
  if (tool === "draw") {
    return { kind: "stroke", ...structuredClone(toolValues.pen) };
  }
  if (tool === "highlighter" || tool === "straight-highlighter") {
    const values = tool === "highlighter" ? toolValues.highlighter : toolValues.straightHighlighter;
    return { kind: "stroke", ...structuredClone(values), pressureEnabled: null };
  }

  const style = structuredClone(toolValues.shapes[tool]);
  const fill = isShapeStyle(style)
    ? { fillColor: style.fillColor, fillOpacity: style.fillOpacity }
    : null;
  const arrowNodes =
    tool === "arrow" ? { start: toolValues.arrow.startNode, end: toolValues.arrow.endNode } : null;
  const structural =
    tool === "coordinate-system"
      ? { kind: tool, dimension: toolValues.coordinateSystem.dimension }
      : tool === "table"
        ? { kind: tool, columns: toolValues.table.columns }
        : null;
  return { kind: "outline", style: outlinePart(style), fill, arrowNodes, structural };
}

function summarizeCommonSelection(elements: readonly InkElementV1[]): SelectionStyleSummary {
  const styles = elements.map((element) =>
    isStrokeStyled(element)
      ? element.style
      : {
          color: element.style.outlineColor,
          width: element.style.outlineWidth,
          opacity: element.style.outlineOpacity,
        },
  );
  return { kind: "common", ...summarizePaint(styles) };
}

function summarizeStrokeSelection(
  elements: readonly (InkElementV1 & { readonly style: StrokeStyleV1 })[],
): StrokeSelectionStyleSummary {
  const styles = elements.map(({ style }) => style);
  const pens = elements.every((element) => element.kind === "stroke" && element.tool === "pen");
  return {
    kind: "stroke",
    ...summarizePaint(styles),
    pressureEnabled: pens ? common(styles.map(({ pressureEnabled }) => pressureEnabled)) : null,
  };
}

function summarizePaint<Width extends OutlineStyleV1["outlineWidth"]>(
  styles: readonly { readonly color: ColorV1; readonly width: Width; readonly opacity: number }[],
) {
  return {
    color: common(
      styles.map(({ color }) => color),
      equalColor,
    ),
    width: common(styles.map(({ width }) => width)),
    opacity: common(styles.map(({ opacity }) => opacity)),
  };
}

function common<T>(
  values: readonly T[],
  equals: (left: T, right: T) => boolean = Object.is,
): MixedValue<T> {
  const first = values[0] as T;
  return values.every((value) => equals(value, first)) ? first : "mixed";
}

function equalColor(left: ColorV1, right: ColorV1): boolean {
  return (
    left.type === right.type &&
    (left.type === "theme-text" || left.value === (right as typeof left).value)
  );
}

function equalNullableColor(left: ColorV1 | null, right: ColorV1 | null): boolean {
  return left === null || right === null ? left === right : equalColor(left, right);
}

function isStrokeStyled(
  element: InkElementV1,
): element is InkElementV1 & { readonly style: StrokeStyleV1 } {
  return element.kind === "stroke" || element.kind === "straight-highlighter";
}

function isOutlineStyled(
  element: InkElementV1,
): element is InkElementV1 & { readonly style: OutlineStyleV1 } {
  return !isStrokeStyled(element);
}

function isClosedShape(
  element: InkElementV1,
): element is InkElementV1 & { readonly style: ShapeStyleV1 } {
  return (
    element.kind === "rectangle" ||
    element.kind === "ellipse" ||
    element.kind === "triangle" ||
    element.kind === "octagon" ||
    element.kind === "parallelogram" ||
    element.kind === "diamond"
  );
}

function isShapeStyle(style: OutlineStyleV1 | ShapeStyleV1): style is ShapeStyleV1 {
  return "fillColor" in style;
}

function outlinePart(style: OutlineStyleV1 | ShapeStyleV1): OutlineStyleV1 {
  return {
    outlineColor: style.outlineColor,
    outlineWidth: style.outlineWidth,
    outlineStyle: style.outlineStyle,
    outlineOpacity: style.outlineOpacity,
  };
}
