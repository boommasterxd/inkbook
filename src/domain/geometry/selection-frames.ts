import type { NotePointV1 } from "../model";
import { materializeGeometryPointV1 } from "./projection";
import type {
  AreaHandleIdV1,
  AreaSelectionHandleV1,
  OrientedSelectionFrameV1,
} from "./selection-types";

const NEGATIVE_DIRECTION = -1;
const HALF = 2;

const HANDLE_LOCATIONS: readonly (readonly [AreaHandleIdV1, number, number])[] =
  [
    ["north-west", NEGATIVE_DIRECTION, NEGATIVE_DIRECTION],
    ["north", 0, NEGATIVE_DIRECTION],
    ["north-east", 1, NEGATIVE_DIRECTION],
    ["east", 1, 0],
    ["south-east", 1, 1],
    ["south", 0, 1],
    ["south-west", NEGATIVE_DIRECTION, 1],
    ["west", NEGATIVE_DIRECTION, 0],
  ];

export function transformFramePointV1(
  frame: OrientedSelectionFrameV1,
  local: NotePointV1,
): NotePointV1 {
  const cosine = Math.cos(frame.rotationRadians);
  const sine = Math.sin(frame.rotationRadians);
  return materializeGeometryPointV1({
    x: frame.center.x + local.x * cosine + local.y * sine,
    y: frame.center.y - local.x * sine + local.y * cosine,
  });
}

export function frameCornersV1(
  frame: OrientedSelectionFrameV1,
): readonly NotePointV1[] {
  const halfWidth = frame.width / HALF;
  const halfHeight = frame.height / HALF;
  return Object.freeze([
    transformFramePointV1(frame, { x: -halfWidth, y: -halfHeight }),
    transformFramePointV1(frame, { x: halfWidth, y: -halfHeight }),
    transformFramePointV1(frame, { x: halfWidth, y: halfHeight }),
    transformFramePointV1(frame, { x: -halfWidth, y: halfHeight }),
  ]);
}

export function createAreaHandlesV1(
  frame: OrientedSelectionFrameV1,
  disabledAxes: Readonly<{ x: boolean; y: boolean }>,
): readonly AreaSelectionHandleV1[] {
  const halfWidth = frame.width / HALF;
  const halfHeight = frame.height / HALF;
  return Object.freeze(
    HANDLE_LOCATIONS.map(([id, xDirection, yDirection]) =>
      Object.freeze({
        id,
        point: transformFramePointV1(frame, {
          x: xDirection * halfWidth,
          y: yDirection * halfHeight,
        }),
        enabled:
          (xDirection === 0 || !disabledAxes.x) &&
          (yDirection === 0 || !disabledAxes.y),
      }),
    ),
  );
}

export function createOrientedFrameV1(
  points: readonly NotePointV1[],
  rotationRadians: number,
): OrientedSelectionFrameV1 | null {
  if (points.length === 0 || !Number.isFinite(rotationRadians)) {
    return null;
  }
  const origin = points[0];
  if (origin === undefined) {
    return null;
  }
  const cosine = Math.cos(rotationRadians);
  const sine = Math.sin(rotationRadians);
  let minimumX = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const deltaX = point.x - origin.x;
    const deltaY = point.y - origin.y;
    const localX = deltaX * cosine - deltaY * sine;
    const localY = deltaX * sine + deltaY * cosine;
    minimumX = Math.min(minimumX, localX);
    maximumX = Math.max(maximumX, localX);
    minimumY = Math.min(minimumY, localY);
    maximumY = Math.max(maximumY, localY);
  }
  const localCenter = {
    x: (minimumX + maximumX) / HALF,
    y: (minimumY + maximumY) / HALF,
  };
  return Object.freeze({
    center: materializeGeometryPointV1({
      x: origin.x + localCenter.x * cosine + localCenter.y * sine,
      y: origin.y - localCenter.x * sine + localCenter.y * cosine,
    }),
    width: maximumX - minimumX,
    height: maximumY - minimumY,
    rotationRadians,
  });
}

export function rotateHandlePointV1(
  frame: OrientedSelectionFrameV1,
): NotePointV1 {
  return transformFramePointV1(frame, { x: 0, y: -frame.height / HALF });
}
