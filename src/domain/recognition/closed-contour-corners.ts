import { pointSegmentDistance } from "../geometry/primitives";
import type { PointV1 } from "../schema/types";

/** Extract at most eight significant corners without discarding the traced path used for fitting. */
export function closedContourCorners(points: readonly PointV1[], tolerance: number): PointV1[] {
  const closed = [...points, points[0]!];
  const keep = new Set([0, closed.length - 1]);
  const pending: [number, number][] = [[0, closed.length - 1]];
  while (pending.length > 0) {
    const [start, end] = pending.pop()!;
    let maximum = tolerance;
    let selected = -1;
    for (let index = start + 1; index < end; index += 1) {
      const error = pointSegmentDistance(closed[index]!, closed[start]!, closed[end]!);
      if (error > maximum) {
        maximum = error;
        selected = index;
      }
    }
    if (selected >= 0) {
      // A side-interior start and its closing duplicate are temporary seam samples,
      // in addition to the eight actual corners admitted below.
      if (keep.size === 10) return [];
      keep.add(selected);
      pending.push([start, selected], [selected, end]);
    }
  }
  const corners = [...keep]
    .sort((a, b) => a - b)
    .slice(0, -1)
    .map((index) => closed[index]!);
  for (let index = corners.length - 1; index >= 0; index -= 1) {
    if (
      pointSegmentDistance(
        corners[index]!,
        corners[(index + corners.length - 1) % corners.length]!,
        corners[(index + 1) % corners.length]!,
      ) <= tolerance
    )
      corners.splice(index, 1);
  }
  return corners.length > 8 ? [] : corners;
}
