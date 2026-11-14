import {
  inverseTextMatrix,
  type TextClientRect,
  type TextEditingMatrix,
} from "../../../rendering/scene/text-editing-geometry";
import type { PaintRectangle } from "../../../domain/geometry/rectangle-cutouts";

/** A collapsed native text range is a transformed vertical, zero-width segment. */
export function inlineTextHeight(
  rectangle: TextClientRect,
  matrix: TextEditingMatrix,
): number | undefined {
  const horizontal = Math.abs(matrix.c);
  const vertical = Math.abs(matrix.d);
  const height =
    horizontal > vertical
      ? (rectangle.right - rectangle.left) / horizontal
      : (rectangle.bottom - rectangle.top) / vertical;
  return Number.isFinite(height) && height > 0 ? height : undefined;
}

/** Recover an oriented native inline rectangle rather than inverting its enclosing AABB. */
export function inlineTextRectangle(
  rectangle: TextClientRect,
  matrix: TextEditingMatrix,
  height: number,
): PaintRectangle | undefined {
  const inverse = inverseTextMatrix(matrix);
  if (!inverse || !Number.isFinite(height) || height <= 0) return undefined;
  const horizontal = Math.abs(matrix.a);
  const vertical = Math.abs(matrix.b);
  const width = Math.max(
    0,
    horizontal >= vertical
      ? (rectangle.right - rectangle.left - Math.abs(matrix.c) * height) / horizontal
      : (rectangle.bottom - rectangle.top - Math.abs(matrix.d) * height) / vertical,
  );
  const left = rectangle.left - Math.min(0, matrix.a * width) - Math.min(0, matrix.c * height);
  const top = rectangle.top - Math.min(0, matrix.b * width) - Math.min(0, matrix.d * height);
  const x = inverse.a * left + inverse.c * top + inverse.e;
  const y = inverse.b * left + inverse.d * top + inverse.f;
  return [x, y, width].every(Number.isFinite) ? { x, y, width, height } : undefined;
}

/** Used CSS sizes remain local even when the surrounding SVG rotates the editor. */
export function localEditorMatrix(
  rectangle: TextClientRect,
  linear: TextEditingMatrix,
  width: number,
  height: number,
): TextEditingMatrix {
  return {
    a: linear.a,
    b: linear.b,
    c: linear.c,
    d: linear.d,
    e: rectangle.left - Math.min(0, linear.a * width) - Math.min(0, linear.c * height),
    f: rectangle.top - Math.min(0, linear.b * width) - Math.min(0, linear.d * height),
  };
}
