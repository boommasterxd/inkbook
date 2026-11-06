import {
  arrowNodeGeometry,
  linearEndpointDirections,
} from "../../../../src/domain/geometry/element-path";
import { quadraticPoint } from "../../../../src/domain/geometry/primitives";
import type { PointV1 } from "../../../../src/domain/schema/types";

export const EDGE_NODES = ["circle", "triangle", "diamond"] as const;
export type EdgeNode = (typeof EDGE_NODES)[number] | "none";

export function edgeShaftPath(curved = false): PointV1[] {
  const start = { x: 0, y: 0 };
  const end = { x: 200, y: 0 };
  const bend = curved ? { x: 90, y: -65 } : { x: 100, y: 0 };
  return Array.from({ length: 81 }, (_, index) => quadraticPoint(start, bend, end, index / 80));
}

export function edgeArrowPath(startNode: EdgeNode, endNode: EdgeNode, curved = false): PointV1[] {
  const shaft = edgeShaftPath(curved);
  const start = shaft[0]!;
  const end = shaft[shaft.length - 1]!;
  const directions = linearEndpointDirections(start, end, curved ? { x: 90, y: -65 } : null);
  return [
    ...edgeMotif(startNode, start, directions.start),
    ...shaft.slice(1),
    ...edgeMotif(endNode, end, directions.end).slice(1),
  ];
}

function edgeMotif(node: EdgeNode, connection: PointV1, outward: PointV1): PointV1[] {
  const endpoint = { x: connection.x + outward.x * 20, y: connection.y + outward.y * 20 };
  const geometry = arrowNodeGeometry(endpoint, outward, node, 20);
  if (geometry.kind === "circle") {
    const angle = Math.atan2(-outward.y, -outward.x);
    return Array.from({ length: 41 }, (_, index) => ({
      x: geometry.center.x + Math.cos(angle + (index * Math.PI) / 20) * geometry.radius,
      y: geometry.center.y + Math.sin(angle + (index * Math.PI) / 20) * geometry.radius,
    }));
  }
  if (geometry.kind !== "polygon") return [connection];
  const vertices =
    node === "triangle"
      ? [connection, geometry.points[1]!, geometry.points[0]!, geometry.points[2]!, connection]
      : [connection, geometry.points[1]!, geometry.points[0]!, geometry.points[3]!, connection];
  return vertices.flatMap((start, index) => {
    const end = vertices[index + 1];
    if (end === undefined) return [start];
    return Array.from({ length: 8 }, (_, step) => ({
      x: start.x + ((end.x - start.x) * step) / 8,
      y: start.y + ((end.y - start.y) * step) / 8,
    }));
  });
}
