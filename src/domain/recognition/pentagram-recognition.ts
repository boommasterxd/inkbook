import { shapeVertices } from "../geometry/creation";
import {
  boundsFromPoints,
  canonicalPoint,
  normalizeRotation,
  pointDistance,
  rotatePointClockwise,
  roundCanonical,
} from "../geometry/primitives";
import type { PointV1 } from "../schema/types";
import type { RecognizedClosedShape } from "./recognition-types";
import { preparePentagramPath } from "./pentagram-path";

const NATIVE_TIPS = shapeVertices({ kind: "star", x: 0, y: 0, width: 1000, height: 1000 })
  .filter((_, index) => index % 2 === 0)
  .map((point) => ({ x: point.x / 1000, y: point.y / 1000 }));
const NATIVE_CENTER = meanPoint(NATIVE_TIPS);
const NATIVE_X_MOMENT = NATIVE_TIPS.reduce(
  (sum, point) => sum + (point.x - NATIVE_CENTER.x) ** 2,
  0,
);
const NATIVE_Y_MOMENT = NATIVE_TIPS.reduce(
  (sum, point) => sum + (point.y - NATIVE_CENTER.y) ** 2,
  0,
);

interface PreparedTips {
  readonly tips: readonly PointV1[];
  readonly center: PointV1;
  readonly diagonal: number;
}

export function recognizePentagram(
  points: readonly PointV1[],
  zoom: number,
): RecognizedClosedShape | null {
  if (points.length < 6 || points.length > 256 || !Number.isFinite(zoom) || zoom <= 0) return null;
  const bounds = boundsFromPoints(points);
  const diagonal = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  const gap = pointDistance(points[0]!, points[points.length - 1]!);
  if (diagonal * zoom < 24 || gap > diagonal * 0.08) return null;
  const tips = preparePentagramPath(points, { diagonal, zoom, gap });
  if (tips === null) return null;
  const prepared = { tips, center: meanPoint(tips), diagonal };
  let best: { shape: RecognizedClosedShape; error: number } | null = null;
  for (const direction of [-1, 1]) {
    for (let shift = 0; shift < 5; shift += 1) {
      const fit = fitTips(prepared, shift, direction);
      if (fit !== null && (best === null || fit.error < best.error)) best = fit;
    }
  }
  return best?.shape ?? null;
}

function fitTips(
  prepared: PreparedTips,
  shift: number,
  direction: number,
): { shape: RecognizedClosedShape; error: number } | null {
  const { tips, center, diagonal } = prepared;
  const native = tips.map((_, index) => NATIVE_TIPS[(shift + direction * index * 2 + 20) % 5]!);
  const origin = NATIVE_CENTER;
  const horizontalFit = fitAxis(tips, native, center, "x");
  const verticalFit = fitAxis(tips, native, center, "y");
  const { horizontal, vertical } = orthogonalBasis(horizontalFit, verticalFit);
  const width = Math.hypot(horizontal.x, horizontal.y);
  const height = Math.hypot(vertical.x, vertical.y);
  const determinant = horizontal.x * vertical.y - horizontal.y * vertical.x;
  if (Math.min(width, height) < diagonal * 0.08 || determinant <= 0) return null;
  const pivot = {
    x: center.x + horizontal.x * (0.5 - origin.x) + vertical.x * (0.5 - origin.y),
    y: center.y + horizontal.y * (0.5 - origin.x) + vertical.y * (0.5 - origin.y),
  };
  const canonicalWidth = roundCanonical(width);
  const canonicalHeight = roundCanonical(height);
  const x = roundCanonical(pivot.x - canonicalWidth / 2);
  const y = roundCanonical(pivot.y - canonicalHeight / 2);
  const shape: RecognizedClosedShape = {
    kind: "star",
    x,
    y,
    width: canonicalWidth,
    height: canonicalHeight,
    rotation: normalizeRotation((Math.atan2(horizontal.y, horizontal.x) * 180) / Math.PI),
    pivot: canonicalPoint({ x: x + canonicalWidth / 2, y: y + canonicalHeight / 2 }),
  };
  const actual = shapeVertices(shape)
    .filter((_, index) => index % 2 === 0)
    .map((point) => rotatePointClockwise(point, shape.pivot, shape.rotation));
  const errors = tips.map((point, index) =>
    pointDistance(point, actual[(shift + direction * index * 2 + 20) % 5]!),
  );
  const error = Math.max(...errors) / diagonal;
  const rms =
    Math.sqrt(errors.reduce((sum, distance) => sum + distance * distance, 0) / 5) / diagonal;
  return error <= 0.065 && rms <= 0.04 ? { error, shape } : null;
}

/** Solve the native rotation and axis scales together; no affine shear is discarded later. */
function orthogonalBasis(horizontal: PointV1, vertical: PointV1) {
  const a =
    NATIVE_X_MOMENT * (horizontal.x ** 2 - horizontal.y ** 2) +
    NATIVE_Y_MOMENT * (vertical.y ** 2 - vertical.x ** 2);
  const b =
    2 * (NATIVE_X_MOMENT * horizontal.x * horizontal.y - NATIVE_Y_MOMENT * vertical.x * vertical.y);
  const angle = Math.atan2(b, a) / 2;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const width = horizontal.x * cosine + horizontal.y * sine;
  const height = -vertical.x * sine + vertical.y * cosine;
  return {
    horizontal: { x: cosine * width, y: sine * width },
    vertical: { x: -sine * height, y: cosine * height },
  };
}

function meanPoint(points: readonly PointV1[]): PointV1 {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function fitAxis(
  tips: readonly PointV1[],
  native: readonly PointV1[],
  center: PointV1,
  axis: "x" | "y",
): PointV1 {
  let x = 0;
  let y = 0;
  for (let index = 0; index < tips.length; index += 1) {
    const offset = native[index]![axis] - NATIVE_CENTER[axis];
    x += (tips[index]!.x - center.x) * offset;
    y += (tips[index]!.y - center.y) * offset;
  }
  const square = axis === "x" ? NATIVE_X_MOMENT : NATIVE_Y_MOMENT;
  return { x: x / square, y: y / square };
}
