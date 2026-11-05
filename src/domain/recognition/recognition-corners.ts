import type { PointV1 } from "../schema/types";

export interface PositionedRecognitionPath {
  points: PointV1[];
  positions: number[];
}

export interface RecognitionCorner {
  point: PointV1;
  position: number;
  salience: number;
}

const MAX_RETAINED_CORNERS = 24;

export function retainRecognitionCorner(
  corners: RecognitionCorner[],
  candidate: RecognitionCorner,
): void {
  if (corners.length < MAX_RETAINED_CORNERS) {
    corners.push(candidate);
    return;
  }
  let weakest = 0;
  for (let index = 1; index < corners.length; index += 1) {
    if (strongerCorner(corners[weakest]!, corners[index]!)) weakest = index;
  }
  if (strongerCorner(candidate, corners[weakest]!)) corners[weakest] = candidate;
}

export function mergeRecognitionCorners(
  path: PositionedRecognitionPath,
  corners: readonly RecognitionCorner[],
): PositionedRecognitionPath {
  const ordered = [...corners].sort((left, right) => left.position - right.position);
  const result: PositionedRecognitionPath = { points: [], positions: [] };
  let pathIndex = 0;
  let cornerIndex = 0;
  while (pathIndex < path.points.length || cornerIndex < ordered.length) {
    const corner = ordered[cornerIndex];
    const position = path.positions[pathIndex];
    if (corner !== undefined && (position === undefined || corner.position <= position)) {
      appendDistinct(result, corner.point, corner.position);
      if (corner.position === position) pathIndex += 1;
      cornerIndex += 1;
    } else {
      appendDistinct(result, path.points[pathIndex]!, position!);
      pathIndex += 1;
    }
  }
  return result;
}

function strongerCorner(left: RecognitionCorner, right: RecognitionCorner): boolean {
  return (
    left.salience > right.salience ||
    (left.salience === right.salience && left.position < right.position)
  );
}

function appendDistinct(path: PositionedRecognitionPath, point: PointV1, position: number): void {
  const previous = path.points[path.points.length - 1];
  if (
    path.positions[path.positions.length - 1] === position ||
    (previous?.x === point.x && previous.y === point.y)
  )
    return;
  path.points.push(point);
  path.positions.push(position);
}
