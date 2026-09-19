import type { PointV1 } from "../schema/types";
import { arcTo, lineTo, moveTo } from "./svg-format";

/** Expands a counterclockwise triangle/diamond by its round-join outline radius. */
export function roundedArrowNodePath(points: readonly PointV1[], radius: number): string {
  const commands: string[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const { entry, exit } = nodeCorner(points, index, radius);
    commands.push(index === 0 ? moveTo(entry) : lineTo(entry), arcTo(radius, 1, exit));
  }
  return `${commands.join("")}Z`;
}

function nodeCorner(points: readonly PointV1[], index: number, radius: number) {
  const corner = points[index]!;
  const previous = points[(index + points.length - 1) % points.length]!;
  const next = points[(index + 1) % points.length]!;
  const incoming = outwardOffset(previous, corner, radius);
  const outgoing = outwardOffset(corner, next, radius);
  return {
    entry: { x: corner.x + incoming.x, y: corner.y + incoming.y },
    exit: { x: corner.x + outgoing.x, y: corner.y + outgoing.y },
  };
}

function outwardOffset(start: PointV1, end: PointV1, radius: number): PointV1 {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const scale = radius / Math.hypot(dx, dy);
  return { x: dy * scale, y: -dx * scale };
}
