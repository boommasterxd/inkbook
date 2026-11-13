import type { Bounds } from "../../domain/geometry/primitives";
import type { TextElementV2 } from "../../domain/schema/types";
import type { SceneCamera } from "./types";
import { multiplyAffineMatrices, type AffineMatrix } from "../../domain/geometry/affine-matrix";

export interface TextEditingBounds {
  /** Page coordinates before the element's own rotation and scene camera. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TextClientRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface TextEditingCoordinates {
  readonly drawingDocument: Document;
  toDrawingPoint(point: {
    readonly x: number;
    readonly y: number;
  }): { readonly x: number; readonly y: number } | undefined;
  fromDrawingPoint(point: {
    readonly x: number;
    readonly y: number;
  }): { readonly x: number; readonly y: number } | undefined;
  toDrawingRect(rect: TextClientRect): TextClientRect | undefined;
}

export interface TextEditingMatrix {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export function inverseTextMatrix(matrix: TextEditingMatrix): TextEditingMatrix | undefined {
  const { a, b, c, d, e, f } = matrix;
  const determinant = a * d - b * c;
  if (![a, b, c, d, e, f, determinant].every(Number.isFinite) || determinant === 0)
    return undefined;
  return {
    a: d / determinant,
    b: -b / determinant,
    c: -c / determinant,
    d: a / determinant,
    e: (c * f - d * e) / determinant,
    f: (b * e - a * f) / determinant,
  };
}

/** Four corners conservatively include rotated caret and viewport rectangles. */
export function textRectBounds(
  rect: TextClientRect,
  matrix: TextEditingMatrix,
): Bounds | undefined {
  if (![rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)) return undefined;
  const corners = [
    [rect.left, rect.top],
    [rect.right, rect.top],
    [rect.right, rect.bottom],
    [rect.left, rect.bottom],
  ] as const;
  const xs = corners.map(([x, y]) => matrix.a * x + matrix.c * y + matrix.e);
  const ys = corners.map(([x, y]) => matrix.b * x + matrix.d * y + matrix.f);
  if (![...xs, ...ys].every(Number.isFinite)) return undefined;
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

export function textCameraMatrix(camera: SceneCamera): TextEditingMatrix {
  return { a: camera.zoom, b: 0, c: 0, d: camera.zoom, e: camera.x * camera.zoom, f: 0 };
}

/** Initial placement uses already known geometry; native CTMs refresh in the scene frame. */
export function textElementMatrix(element: TextElementV2, camera: SceneCamera): TextEditingMatrix {
  const angle = (element.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const { x, y } = element.pivot;
  return {
    a: cos * camera.zoom,
    b: sin * camera.zoom,
    c: -sin * camera.zoom,
    d: cos * camera.zoom,
    e: (x - cos * x + sin * y + camera.x) * camera.zoom,
    f: (y - sin * x - cos * y) * camera.zoom,
  };
}

/** Rebase retained glyph coordinates when the next complete native layout is still staged. */
export function textBasisRebaseMatrix(source: TextElementV2, target: TextElementV2): AffineMatrix {
  const camera = { x: 0, zoom: 1 };
  const inverse = inverseTextMatrix(textElementMatrix(source, camera));
  if (!inverse || source.width <= 0 || source.height <= 0) return [1, 0, 0, 1, 0, 0];
  const x = target.width / source.width;
  const y = target.height / source.height;
  return multiplyAffineMatrices(
    affineArray(textElementMatrix(target, camera)),
    multiplyAffineMatrices(
      [x, 0, 0, y, target.x - source.x * x, target.y - source.y * y],
      affineArray(inverse),
    ),
  );
}

function affineArray(matrix: TextEditingMatrix): AffineMatrix {
  return [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
}

export function textPreviewMatrix(
  element: TextElementV2,
  preview?: AffineMatrix,
): TextEditingMatrix {
  const own = textElementMatrix(element, { x: 0, zoom: 1 });
  if (preview === undefined) return own;
  const [a, b, c, d, e, f] = multiplyAffineMatrices(preview, affineArray(own));
  return { a, b, c, d, e, f };
}
