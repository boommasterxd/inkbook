import { linearEndpointDirections } from "../../../../src/domain/geometry/element-path";
import { quadraticPoint } from "../../../../src/domain/geometry/primitives";
import type { ArrowNodeV1, PointV1 } from "../../../../src/domain/schema/types";
import { endpointMotif } from "./arrow-fixtures";

export function shallowLinePath(sagitta: number, length = 240, jitter = 0): PointV1[] {
  return Array.from({ length: 121 }, (_, index) => {
    const t = index / 120;
    const point = quadraticPoint(
      { x: 0, y: 0 },
      { x: length / 2, y: 2 * sagitta },
      { x: length, y: 0 },
      t,
    );
    return { x: point.x, y: point.y + jitter * Math.sin(12 * Math.PI * t) };
  });
}

export function shallowArrowPath(
  sagitta: number,
  startNode: ArrowNodeV1,
  endNode: ArrowNodeV1,
): PointV1[] {
  const shaft = shallowLinePath(sagitta);
  const start = shaft[0]!;
  const end = shaft[shaft.length - 1]!;
  const directions = linearEndpointDirections(start, end, { x: 120, y: 2 * sagitta });
  return [
    ...placeMotif(startNode, start, directions.start).reverse(),
    ...shaft.slice(1, -1),
    ...placeMotif(endNode, end, directions.end),
  ];
}

function placeMotif(node: ArrowNodeV1, tip: PointV1, outward: PointV1): PointV1[] {
  return endpointMotif(node).map((point) => ({
    x: tip.x + (point.x - 120) * outward.x - point.y * outward.y,
    y: tip.y + (point.x - 120) * outward.y + point.y * outward.x,
  }));
}
