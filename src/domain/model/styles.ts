export type HexRgbaV1 = string & { readonly __brand: "HexRgbaV1" };
type PaintColorV1 = "currentColor" | HexRgbaV1;
type DashPatternV1 = "solid" | "dashed" | "dotted";
type EndpointCapV1 = "none" | "arrow" | "dot" | "circle" | "diamond" | "bar";

interface StrokePaintV1 {
  readonly color: PaintColorV1;
  readonly opacity: number;
  readonly width: number;
  readonly dash: DashPatternV1;
}

type FillV1 =
  | { readonly kind: "none" }
  | {
      readonly kind: "solid";
      readonly color: PaintColorV1;
      readonly opacity: number;
    };

export interface PenStyleV1 extends StrokePaintV1 {
  readonly pressure: "constant" | "pointer";
  readonly smoothing: number;
  readonly streamline: number;
  readonly thinning: number;
  readonly strokeProfileVersion: 1;
}

export interface HighlighterStyleV1 extends StrokePaintV1 {
  readonly variant: "freehand" | "straight";
}

export interface ShapeStyleV1 extends StrokePaintV1 {
  readonly fill: FillV1;
}

export interface LinearStyleV1 extends StrokePaintV1 {
  readonly startCap: EndpointCapV1;
  readonly endCap: EndpointCapV1;
  readonly capSize: number;
}

export interface ConstructionStyleV1 extends StrokePaintV1 {
  readonly positiveEndCap: EndpointCapV1;
  readonly capSize: number;
}

export type CanonicalStyleV1 =
  | PenStyleV1
  | HighlighterStyleV1
  | ShapeStyleV1
  | LinearStyleV1
  | ConstructionStyleV1;

const HEX_RGBA_PATTERN = /^#[0-9a-f]{8}$/u;

export function parseHexRgbaV1(value: string): HexRgbaV1 {
  if (!HEX_RGBA_PATTERN.test(value)) {
    throw new TypeError("Invalid hexadecimal RGBA color syntax.");
  }
  return value as HexRgbaV1;
}

export function materializePenStyleV1(style: PenStyleV1): PenStyleV1 {
  return Object.freeze({ ...style });
}

export function materializeHighlighterStyleV1(
  style: HighlighterStyleV1,
): HighlighterStyleV1 {
  return Object.freeze({ ...style });
}

export function materializeShapeStyleV1(style: ShapeStyleV1): ShapeStyleV1 {
  return Object.freeze({ ...style, fill: Object.freeze({ ...style.fill }) });
}

export function materializeLinearStyleV1(style: LinearStyleV1): LinearStyleV1 {
  return Object.freeze({ ...style });
}

export function materializeConstructionStyleV1(
  style: ConstructionStyleV1,
): ConstructionStyleV1 {
  return Object.freeze({ ...style });
}
