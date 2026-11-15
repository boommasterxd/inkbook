import { multiplyAffineMatrices, type AffineMatrix } from "../../domain/geometry/affine-matrix";
import { inverseTextMatrix } from "./text-editing-geometry";
import { textRectBounds } from "./text-editing-geometry";
import type { Bounds } from "../../domain/geometry/primitives";

const IDENTITY: AffineMatrix = [1, 0, 0, 1, 0, 0];

/** Reads only authored transforms, without a layout-dependent getCTM/getBBox call. */
export function autoPaintTransform(node: SVGElement, root: SVGGElement): AffineMatrix {
  const parents: SVGElement[] = [];
  for (
    let current: Element | null = node;
    current !== null && current !== root;
    current = current.parentElement
  )
    parents.push(current as SVGElement);
  let matrix = IDENTITY;
  for (const parent of parents.reverse()) {
    const motion = parent.style.getPropertyValue("transform");
    const local = motion
      ? motionTransform(parent, motion)
      : transformList(parent.getAttribute("transform") ?? "");
    matrix = multiplyAffineMatrices(matrix, local);
  }
  return matrix;
}

export function autoPaintLocalBounds(bounds: Bounds, matrix: AffineMatrix): Bounds | undefined {
  const [a, b, c, d, e, f] = matrix;
  const inverse = inverseTextMatrix({ a, b, c, d, e, f });
  return inverse === undefined
    ? undefined
    : textRectBounds(
        {
          left: bounds.minX,
          top: bounds.minY,
          right: bounds.maxX,
          bottom: bounds.maxY,
        },
        inverse,
      );
}

export function autoPaintBounds(bounds: Bounds, matrix: AffineMatrix): Bounds | undefined {
  const [a, b, c, d, e, f] = matrix;
  return textRectBounds(
    { left: bounds.minX, top: bounds.minY, right: bounds.maxX, bottom: bounds.maxY },
    { a, b, c, d, e, f },
  );
}

/** The smallest singular scale also bounds rotated, nonuniform selection transforms. */
export function autoPaintMinimumStride(matrix: AffineMatrix, zoom: number): number {
  const [a, b, c, d] = matrix;
  const trace = a * a + b * b + c * c + d * d;
  const determinant = Math.abs(a * d - b * c);
  const largest = Math.sqrt(
    (trace + Math.sqrt(Math.max(0, trace * trace - 4 * determinant ** 2))) / 2,
  );
  const effectiveZoom = zoom * (largest === 0 ? 1 : determinant / largest);
  return 2 ** Math.ceil(Math.log2(Math.max(32, 32 / Math.max(Number.EPSILON, effectiveZoom))));
}

function motionTransform(node: SVGElement, value: string): AffineMatrix {
  const origin = node.style
    .getPropertyValue("transform-origin")
    .trim()
    .split(/\s+/)
    .map((part) => Number.parseFloat(part));
  const x = origin[0] ?? 0;
  const y = origin[1] ?? 0;
  const matrix = transformList(value);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return matrix;
  return multiplyAffineMatrices(
    [1, 0, 0, 1, x, y],
    multiplyAffineMatrices(matrix, [1, 0, 0, 1, -x, -y]),
  );
}

export function inverseAutoPaintTransform(matrix: AffineMatrix): string | undefined {
  const [a, b, c, d, e, f] = matrix;
  const inverse = inverseTextMatrix({ a, b, c, d, e, f });
  return inverse === undefined
    ? undefined
    : `matrix(${[inverse.a, inverse.b, inverse.c, inverse.d, inverse.e, inverse.f].join(" ")})`;
}

function transformList(value: string): AffineMatrix {
  let matrix = IDENTITY;
  for (const match of value.matchAll(/(matrix|translate|scale|rotate)\(([^)]*)\)/g)) {
    const values = match[2]!
      .trim()
      .split(/[\s,]+/)
      .map((part) => Number(part.replace(/(?:px|deg)$/, "")));
    if (values.some((item) => !Number.isFinite(item))) continue;
    matrix = multiplyAffineMatrices(matrix, operation(match[1]!, values));
  }
  return matrix;
}

function operation(name: string, values: readonly number[]): AffineMatrix {
  const first = values[0] ?? 0;
  if (name === "matrix" && values.length === 6) return values as unknown as AffineMatrix;
  if (name === "translate") return [1, 0, 0, 1, first, values[1] ?? 0];
  if (name === "scale") return [first, 0, 0, values[1] ?? first, 0, 0];
  if (name !== "rotate") return IDENTITY;
  const radians = (first * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const x = values[1] ?? 0;
  const y = values[2] ?? 0;
  return [cos, sin, -sin, cos, x - cos * x + sin * y, y - sin * x - cos * y];
}
