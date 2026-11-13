import { multiplyAffineMatrices, type AffineMatrix } from "../../domain/geometry/affine-matrix";

export type MathMatrix = AffineMatrix;
export const IDENTITY_MATH_MATRIX: MathMatrix = [1, 0, 0, 1, 0, 0];

export const multiplyMathMatrices = multiplyAffineMatrices;

export function mathTransformMatrix(source: string): MathMatrix {
  let result = IDENTITY_MATH_MATRIX;
  let consumed = "";
  for (const match of source.matchAll(/(matrix|translate|scale|rotate)\s*\(([^)]*)\)/gu)) {
    consumed += match[0];
    const values = mathNumbers(match[2]!);
    result = multiplyMathMatrices(result, operationMatrix(match[1]!, values));
  }
  if (source.replace(/[\s,]/gu, "") !== consumed.replace(/[\s,]/gu, ""))
    throw new Error("Unsupported math transform.");
  return result;
}

export function mathNumbers(source: string): number[] {
  const tokens = source.match(/[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?/giu) ?? [];
  if (source.replace(/[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?/giu, "").replace(/[\s,]/gu, ""))
    throw new Error("Invalid math coordinates.");
  const result = tokens.map(Number);
  if (result.some((value) => !Number.isFinite(value))) throw new Error("Invalid math coordinates.");
  return result;
}

export function transformMathPoint(matrix: MathMatrix, x: number, y: number): string {
  return `${mathCoordinate(matrix[0] * x + matrix[2] * y + matrix[4])} ${mathCoordinate(matrix[1] * x + matrix[3] * y + matrix[5])}`;
}

export function mathCoordinate(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) > 100_000_000)
    throw new Error("Math geometry exceeds the coordinate limit.");
  return String(canonicalizeGeometryNumber(value));
}

function operationMatrix(name: string, values: number[]): MathMatrix {
  if (name === "matrix" && values.length === 6) return values as unknown as MathMatrix;
  if (name === "translate" && (values.length === 1 || values.length === 2))
    return [1, 0, 0, 1, values[0]!, values[1] ?? 0];
  if (name === "scale" && (values.length === 1 || values.length === 2))
    return [values[0]!, 0, 0, values[1] ?? values[0]!, 0, 0];
  if (name === "rotate" && (values.length === 1 || values.length === 3)) {
    const angle = (values[0]! * Math.PI) / 180;
    const rotation: MathMatrix = [
      Math.cos(angle),
      Math.sin(angle),
      -Math.sin(angle),
      Math.cos(angle),
      0,
      0,
    ];
    const x = values[1] ?? 0;
    const y = values[2] ?? 0;
    return multiplyMathMatrices(multiplyMathMatrices([1, 0, 0, 1, x, y], rotation), [
      1,
      0,
      0,
      1,
      -x,
      -y,
    ]);
  }
  throw new Error("Invalid math transform.");
}
import { canonicalizeGeometryNumber } from "../../domain/schema/canonical";
