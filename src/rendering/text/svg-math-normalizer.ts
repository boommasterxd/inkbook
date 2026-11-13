import type { TextMathLayoutV2 } from "../../domain/schema/public";
import { normalizeMathPath } from "./math-path-normalizer";
import {
  mathCoordinate,
  mathNumbers,
  mathTransformMatrix,
  multiplyMathMatrices,
  type MathMatrix,
} from "./math-path-transform";
import {
  admitTextLayout,
  type ResolvedTextMath,
  type TextLayoutPorts,
  type MathSvgTree,
} from "./text-layout-types";
import {
  mathSvgCoordinate,
  mathSvgPaint,
  mathSvgShape,
  type MathSvgPaint,
} from "./math-svg-shapes";
export type { MathSvgTree } from "./text-layout-types";

type Admission = Pick<TextLayoutPorts, "scheduler" | "signal">;
interface MathSvgVisit<Node> {
  node: Node;
  matrix: MathMatrix;
  depth: number;
  paint: MathSvgPaint;
}
const MAX_NODES = 16_384;
const PAINTED_SHAPES: readonly string[] = ["path", "rect", "line"];

/** Accepts a trusted typesetter tree, but retains only bounded portable path geometry. */
export async function normalizeMathSvg<Node>(
  root: Node,
  tree: MathSvgTree<Node>,
  fontSize: number,
  admission: Admission,
  viewportWidth?: number,
): Promise<ResolvedTextMath> {
  const nativeViewBox = tree.attribute(root, "viewBox");
  const box = mathNumbers(nativeViewBox ?? tree.attribute(root, "data-mjx-viewBox") ?? "");
  if (box.length !== 4 || box[2]! < 0 || box[3]! < 0 || tree.kind(root) !== "svg")
    throw new Error("Invalid math SVG view box.");
  const scale = fontSize / 1000;
  const rootMatrix: MathMatrix = nativeViewBox
    ? [scale, 0, 0, scale, -box[0]! * scale, -box[1]! * scale]
    : [1, 0, 0, 1, 0, 0];
  const ids = await mathSvgIds(root, tree, admission);
  const pending: MathSvgVisit<Node>[] = [
    { node: root, matrix: rootMatrix, depth: 0, paint: { fill: true, strokeWidth: 0 } },
  ];
  const paths: TextMathLayoutV2["paths"] = [];
  let nodes = 0;
  let characters = 0;
  while (pending.length) {
    await admitTextLayout(admission);
    const current = pending.pop()!;
    if (++nodes > MAX_NODES || current.depth > 64)
      throw new Error("Math SVG exceeds the item limit.");
    const { node } = current;
    const kind = tree.kind(node);
    const paint = mathSvgPaint(node, tree, current.paint);
    const matrix = multiplyMathMatrices(
      current.matrix,
      mathTransformMatrix(tree.attribute(node, "transform") ?? ""),
    );
    if (PAINTED_SHAPES.includes(kind)) {
      const geometry = mathSvgShape(node, tree, paint);
      if (!geometry) continue;
      const d = normalizeMathPath(geometry.d, matrix);
      // Space glyphs have no ink; their advance remains in the typesetter's math box.
      if (d.length === 0) continue;
      characters += d.length;
      if (characters > 2_000_000) throw new Error("Math SVG exceeds the geometry limit.");
      paths.push({ d, ...(geometry.fillRule ? { fillRule: geometry.fillRule } : {}) });
    } else appendVisits({ ...current, matrix, paint }, tree, ids, pending);
  }
  const height = Number(mathCoordinate(box[3]! * scale));
  const ascent = Math.max(0, Math.min(height, -box[1]! * scale));
  return {
    width: Number(
      mathCoordinate(
        !nativeViewBox && viewportWidth !== undefined
          ? Math.max(viewportWidth, box[2]! * scale)
          : box[2]! * scale,
      ),
    ),
    height,
    ascent,
    descent: height - ascent,
    paths,
  };
}

function appendVisits<Node>(
  current: MathSvgVisit<Node>,
  tree: MathSvgTree<Node>,
  ids: Map<string, Node>,
  pending: MathSvgVisit<Node>[],
): void {
  const { node, matrix } = current;
  const kind = tree.kind(node);
  if (["defs", "title", "desc"].includes(kind)) return;
  if (kind === "use") {
    const href = tree.attribute(node, "href") ?? tree.attribute(node, "xlink:href") ?? "";
    const reference = href.startsWith("#") ? ids.get(href.slice(1)) : undefined;
    if (!reference) throw new Error("Unresolved math SVG reference.");
    const translated = multiplyMathMatrices(matrix, [
      1,
      0,
      0,
      1,
      mathSvgCoordinate(node, tree, "x"),
      mathSvgCoordinate(node, tree, "y"),
    ]);
    pending.push({
      node: reference,
      matrix: translated,
      depth: current.depth + 1,
      paint: current.paint,
    });
    return;
  }
  if (kind !== "svg" && kind !== "g") throw new Error(`Unsupported math SVG element: ${kind}.`);
  const children = tree.children(node);
  for (let index = children.length - 1; index >= 0; index -= 1)
    pending.push({
      node: children[index]!,
      matrix,
      depth: current.depth + 1,
      paint: current.paint,
    });
}

async function mathSvgIds<Node>(
  root: Node,
  tree: MathSvgTree<Node>,
  admission: Admission,
): Promise<Map<string, Node>> {
  const ids = new Map<string, Node>();
  const pending = [root];
  let count = 0;
  while (pending.length) {
    await admitTextLayout(admission);
    if (++count > MAX_NODES) throw new Error("Math SVG exceeds the item limit.");
    const node = pending.pop()!;
    const id = tree.attribute(node, "id");
    if (id) ids.set(id, node);
    for (const child of tree.children(node)) pending.push(child);
  }
  return ids;
}
