import { mathNumbers } from "./math-path-transform";
import type { MathSvgTree } from "./text-layout-types";

export interface MathSvgPaint {
  readonly fill: boolean;
  readonly strokeWidth: number;
}
export interface MathSvgGeometry {
  readonly d: string;
  readonly fillRule?: "evenodd";
}

export function mathSvgPaint<Node>(
  node: Node,
  tree: MathSvgTree<Node>,
  inherited: MathSvgPaint,
): MathSvgPaint {
  const fill = tree.attribute(node, "fill");
  const width = tree.attribute(node, "stroke-width");
  const strokeWidth =
    width === null ? inherited.strokeWidth : mathSvgCoordinate(node, tree, "stroke-width");
  if (strokeWidth < 0) throw new Error("Invalid math SVG stroke.");
  return {
    fill: fill === null ? inherited.fill : fill !== "none",
    strokeWidth: tree.attribute(node, "stroke") === "none" ? 0 : strokeWidth,
  };
}

export function mathSvgShape<Node>(
  node: Node,
  tree: MathSvgTree<Node>,
  paint: MathSvgPaint,
): MathSvgGeometry | undefined {
  const kind = tree.kind(node);
  if (kind === "line") return { d: linePath(node, tree, paint.strokeWidth) };
  if (kind === "rect") return rectangleGeometry(node, tree, paint);
  if (paint.strokeWidth > 0) throw new Error("Unsupported stroked math path.");
  if (!paint.fill) return undefined;
  const fillRule = tree.attribute(node, "fill-rule");
  return { d: tree.attribute(node, "d") ?? "", ...(fillRule === "evenodd" ? { fillRule } : {}) };
}

export function mathSvgCoordinate<Node>(node: Node, tree: MathSvgTree<Node>, name: string): number {
  const value = tree.attribute(node, name);
  if (value === null) return 0;
  const values = mathNumbers(value);
  if (values.length !== 1) throw new Error("Invalid math SVG coordinate.");
  return values[0]!;
}

function rectangleGeometry<Node>(
  node: Node,
  tree: MathSvgTree<Node>,
  paint: MathSvgPaint,
): MathSvgGeometry | undefined {
  const x = mathSvgCoordinate(node, tree, "x");
  const y = mathSvgCoordinate(node, tree, "y");
  const width = mathSvgCoordinate(node, tree, "width");
  const height = mathSvgCoordinate(node, tree, "height");
  if (width < 0 || height < 0) throw new Error("Invalid math SVG rectangle.");
  if (!paint.fill && paint.strokeWidth === 0) return undefined;
  const half = paint.strokeWidth / 2;
  const outer = rectanglePath(
    x - half,
    y - half,
    width + paint.strokeWidth,
    height + paint.strokeWidth,
  );
  if (paint.fill || width <= paint.strokeWidth || height <= paint.strokeWidth) return { d: outer };
  return {
    d:
      outer +
      rectanglePath(x + half, y + half, width - paint.strokeWidth, height - paint.strokeWidth),
    fillRule: "evenodd",
  };
}

function rectanglePath(x: number, y: number, width: number, height: number): string {
  return `M${x} ${y}H${x + width}V${y + height}H${x}Z`;
}

function linePath<Node>(node: Node, tree: MathSvgTree<Node>, width: number): string {
  if (width <= 0 || tree.attribute(node, "stroke-dasharray"))
    throw new Error("Unsupported math SVG line stroke.");
  const cap = tree.attribute(node, "stroke-linecap") ?? "butt";
  if (cap !== "butt" && cap !== "square") throw new Error("Unsupported math SVG line cap.");
  const x1 = mathSvgCoordinate(node, tree, "x1");
  const y1 = mathSvgCoordinate(node, tree, "y1");
  const x2 = mathSvgCoordinate(node, tree, "x2");
  const y2 = mathSvgCoordinate(node, tree, "y2");
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (length === 0) return "";
  const normalX = ((-(y2 - y1) / length) * width) / 2;
  const normalY = (((x2 - x1) / length) * width) / 2;
  const extension = cap === "square" ? width / (2 * length) : 0;
  const dx = (x2 - x1) * extension;
  const dy = (y2 - y1) * extension;
  return `M${x1 - dx + normalX} ${y1 - dy + normalY}L${x2 + dx + normalX} ${y2 + dy + normalY}L${x2 + dx - normalX} ${y2 + dy - normalY}L${x1 - dx - normalX} ${y1 - dy - normalY}Z`;
}
