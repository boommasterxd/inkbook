import type { PointV1, StrokeElementV1 } from "../schema/types";
import { midpoint } from "./primitives";
import {
  buildPressureOutlinePairs,
  pressureWidthFactor,
  transformedStrokeCenters,
} from "./stroke-path";
import { arcTo, lineTo, moveTo, quadraticTo } from "./svg-format";

/** Reconstructs the former outline exactly, solely for persisted SVG integrity checks. */
export function buildLegacyPressureOutlinePath(stroke: StrokeElementV1): string {
  const centers = transformedStrokeCenters(stroke);
  const first = centers[0]!;
  if (centers.length === 1) {
    const radius = (stroke.style.width * pressureWidthFactor(first.pressure)) / 2;
    const left = { x: first.x - radius, y: first.y };
    const right = { x: first.x + radius, y: first.y };
    return `${moveTo(left)}${arcTo(radius, 1, right)}${arcTo(radius, 1, left)}Z`;
  }
  const pairs = buildPressureOutlinePairs(centers, stroke.style.width);
  const left = pairs.map((pair) => pair.left);
  const right = pairs.map((pair) => pair.right).reverse();
  const endPair = pairs[pairs.length - 1]!;
  const startPair = pairs[0]!;
  return [
    moveTo(left[0]!),
    appendMidpointPath(left),
    arcTo(endPair.radius, 0, endPair.right),
    appendMidpointPath(right),
    arcTo(startPair.radius, 0, startPair.left),
    "Z",
  ].join("");
}

function appendMidpointPath(points: readonly PointV1[]): string {
  if (points.length === 2) return lineTo(points[1]!);
  const commands = [lineTo(midpoint(points[0]!, points[1]!))];
  for (let index = 1; index < points.length - 1; index += 1) {
    commands.push(quadraticTo(points[index]!, midpoint(points[index]!, points[index + 1]!)));
  }
  commands.push(lineTo(points[points.length - 1]!));
  return commands.join("");
}
