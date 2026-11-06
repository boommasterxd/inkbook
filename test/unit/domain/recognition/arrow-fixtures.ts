import type { ArrowNodeV1, PointV1 } from "../../../../src/domain/schema/types";

const ENDPOINT_NODES: readonly ArrowNodeV1[] = ["none", "arrow", "triangle", "diamond", "circle"];

export const ARROW_ENDPOINT_PAIRS = ENDPOINT_NODES.flatMap((start) =>
  ENDPOINT_NODES.filter((end) => start !== "none" || end !== "none").map(
    (end) => [start, end] as const,
  ),
);

export function endpointMotif(node: ArrowNodeV1): PointV1[] {
  const tip = { x: 120, y: 0 };
  const upper = { x: 100, y: 10 };
  const lower = { x: 100, y: -10 };
  if (node === "none") return [tip];
  if (node === "arrow") return [tip, upper, tip, lower];
  if (node === "triangle") return [tip, upper, lower, tip];
  if (node === "diamond") {
    return [tip, { x: 110, y: 10 }, { x: 100, y: 0 }, { x: 110, y: -10 }, tip];
  }
  return Array.from({ length: 25 }, (_, index) => {
    if (index === 24) return tip;
    const angle = (index * Math.PI) / 12;
    return { x: 110 + 10 * Math.cos(angle), y: 10 * Math.sin(angle) };
  });
}

export function arrowPath(start: ArrowNodeV1, end: ArrowNodeV1): PointV1[] {
  const beginning = endpointMotif(start)
    .map((point) => ({ x: 120 - point.x, y: point.y === 0 ? 0 : -point.y }))
    .reverse();
  return [...beginning, { x: 30, y: 0 }, { x: 60, y: 0 }, { x: 90, y: 0 }, ...endpointMotif(end)];
}
