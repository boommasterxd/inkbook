import type { PointV1 } from "../schema/types";
import { pointDistance } from "../geometry/primitives";
import { recognizeArrowSteps } from "./arrow-recognition";
import { recognizeClosedShapeSteps } from "./closed-recognition";
import { recognizeLinear } from "./linear-recognition";
import type { RecognizedShape } from "./recognition-types";
import { normalizeRecognitionStrokeSteps } from "./stroke-normalization";
import { recognizePentagram } from "./pentagram-recognition";

export type { RecognizedShape } from "./recognition-types";

export function* recognizeStrokeSteps(
  points: readonly number[],
  options: { zoom: number },
): Generator<void, RecognizedShape | null> {
  const stroke = yield* normalizeRecognitionStrokeSteps(points, options.zoom);
  if (stroke === null) return null;
  const fitLinear = (path: readonly PointV1[]) => recognizeLinear(path, options.zoom);
  const line = fitLinear(stroke.points);
  if (line !== null) {
    if (!hasEndpointRetracing(stroke.points, stroke.length, options.zoom)) return line;
    yield;
    return (yield* recognizeArrowSteps(stroke.points, fitLinear, options.zoom)) ?? line;
  }
  yield;
  const pentagram = recognizePentagram(stroke.points, options.zoom);
  if (pentagram !== null) return pentagram;
  const closed = yield* recognizeClosedShapeSteps(stroke.points, stroke.diagonal);
  if (closed !== null) return closed;
  // An unresolved loop must not become an oversized arrowhead on its closing seam.
  if (
    stroke.length > stroke.diagonal * 2 &&
    pointDistance(stroke.points[0]!, stroke.points[stroke.points.length - 1]!) <=
      stroke.diagonal * 0.2
  )
    return null;
  yield;
  return yield* recognizeArrowSteps(stroke.points, fitLinear, options.zoom);
}

function hasEndpointRetracing(points: readonly PointV1[], length: number, zoom: number): boolean {
  const start = points[0]!;
  const end = points[points.length - 1]!;
  const chord = pointDistance(start, end);
  const dx = (end.x - start.x) / chord;
  const dy = (end.y - start.y) / chord;
  const endpointRange = Math.max(length * 0.2, 12 / zoom);
  let travelled = 0;
  let furthest = 0;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]!;
    travelled += pointDistance(points[index - 1]!, point);
    const projection = (point.x - start.x) * dx + (point.y - start.y) * dy;
    furthest = Math.max(furthest, projection);
    if (
      (travelled < endpointRange || travelled > length - endpointRange) &&
      (furthest - projection) * zoom > 1.5
    )
      return true;
  }
  return false;
}
