import { linearEndpointDirections } from "../../../../src/domain/geometry/element-path";
import type { ArrowNodeV1, PointV1 } from "../../../../src/domain/schema/types";

export function irregularArrowPath(
  startNode: ArrowNodeV1,
  endNode: ArrowNodeV1,
  curved = false,
): PointV1[] {
  const start = { x: 0, y: 0 };
  const end = { x: 400, y: 0 };
  const bend = curved ? { x: 200, y: -120 } : null;
  const directions = linearEndpointDirections(start, end, bend);
  const body = Array.from({ length: 101 }, (_, index) => {
    const t = index / 100;
    return { x: 400 * t, y: (curved ? -240 * t * (1 - t) : 0) + 6 * Math.sin(4 * Math.PI * t) };
  });
  const beginning = irregularMotif(startNode)
    .map((point) => place(point, start, directions.start))
    .reverse();
  const ending = irregularMotif(endNode).map((point) => place(point, end, directions.end));
  return [...beginning, ...body.slice(1, -1), ...ending];
}

/** A single pen trace returns beside the first flank before completing the marker. */
export function doubleTrackedArrowPath(
  node: Exclude<ArrowNodeV1, "none">,
  gap: number,
  curved = false,
  headScale = 1,
): PointV1[] {
  const body = irregularArrowPath("none", "none", curved);
  const end = body[body.length - 1]!;
  const direction = linearEndpointDirections(
    body[0]!,
    end,
    curved ? { x: 200, y: -120 } : null,
  ).end;
  const motif = irregularMotif(node).map((point) => ({
    x: point.x * headScale,
    y: point.y * headScale,
  }));
  const flank = motif.slice(0, node === "circle" ? 13 : 10);
  const wing = flank[flank.length - 1]!;
  const length = Math.hypot(wing.x, wing.y);
  const offset = { x: (wing.y * gap) / length, y: (-wing.x * gap) / length };
  const retrace = [...flank].reverse().map((point) => ({
    x: point.x + offset.x,
    y: point.y + offset.y,
  }));
  const rest = motif.slice(node === "arrow" ? 19 : 1);
  const contour = [...flank, ...retrace, ...rest].map((point) => place(point, end, direction));
  return [...body.slice(0, -1), ...contour];
}

function irregularMotif(node: ArrowNodeV1): PointV1[] {
  const tip = { x: 0, y: 0 };
  if (node === "none") return [tip];
  if (node === "circle")
    return Array.from({ length: 49 }, (_, index) => {
      const angle = (index * Math.PI) / 24;
      return { x: 22 * (Math.cos(angle) - 1), y: 20 * Math.sin(angle) + 1.6 * Math.sin(3 * angle) };
    });
  const upper = { x: -38, y: 26 };
  const lower = { x: -48, y: -19 };
  const vertices =
    node === "arrow"
      ? [tip, upper, tip, lower]
      : node === "triangle"
        ? [tip, { x: -43, y: 27 }, { x: -34, y: -22 }, tip]
        : [tip, { x: -14, y: 24 }, { x: -46, y: 1 }, { x: -28, y: -18 }, tip];
  return vertices.flatMap((point, index) => {
    const next = vertices[index + 1];
    if (next === undefined) return [point];
    return Array.from({ length: 9 }, (_, step) => ({
      x: point.x + ((next.x - point.x) * step) / 9,
      y: point.y + ((next.y - point.y) * step) / 9,
    }));
  });
}

function place(point: PointV1, tip: PointV1, outward: PointV1): PointV1 {
  return {
    x: tip.x + point.x * outward.x - point.y * outward.y,
    y: tip.y + point.x * outward.y + point.y * outward.x,
  };
}
