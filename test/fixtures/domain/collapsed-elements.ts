import type { InkElementV1, OutlineStyleV1, PointV1 } from "../../../src/domain/schema/public";

export function collapsedElements(size: number): InkElementV1[] {
  const origin = { x: 0, y: 0 };
  const outline: OutlineStyleV1 = {
    outlineColor: { type: "theme-text" },
    outlineWidth: 4,
    outlineOpacity: 1,
    outlineStyle: "solid",
  };
  const base = { createdAt: 0, rotation: 0, pivot: origin };
  const elements: InkElementV1[] = [];
  const id = () => `00000000-0000-4000-8000-${String(elements.length + 1).padStart(12, "0")}`;
  elements.push({
    ...base,
    id: id(),
    kind: "straight-highlighter",
    start: origin,
    end: { x: size, y: 0 },
    bend: null,
    startNode: "none",
    endNode: "none",
    style: {
      color: { type: "theme-text" },
      width: 4,
      opacity: 1,
      pressureEnabled: false,
      smoothing: 0.5,
    },
  });
  for (const kind of ["line", "arrow"] as const) {
    elements.push({
      ...base,
      id: id(),
      ...(kind === "arrow"
        ? { kind, endNode: "arrow" as const }
        : { kind, endNode: "none" as const }),
      start: origin,
      end: { x: size, y: 0 },
      bend: null,
      startConnection: null,
      endConnection: null,
      startNode: "none",
      style: outline,
    });
  }
  for (const kind of [
    "rectangle",
    "ellipse",
    "triangle",
    "octagon",
    "parallelogram",
    "diamond",
  ] as const) {
    elements.push({
      ...base,
      id: id(),
      kind,
      x: 0,
      y: 0,
      width: size * 2,
      height: size * 2,
      pivot: { x: size, y: size },
      style: { ...outline, fillColor: null, fillOpacity: 0 },
    });
  }
  for (const dimension of ["2d", "3d"] as const) {
    elements.push({
      ...base,
      id: id(),
      kind: "coordinate-system",
      origin,
      ...(dimension === "2d"
        ? { dimension, axes: [{ x: size, y: 0 }, origin] as [PointV1, PointV1] }
        : { dimension, axes: [{ x: size, y: 0 }, origin, origin] as [PointV1, PointV1, PointV1] }),
      style: outline,
    });
  }
  elements.push({
    ...base,
    id: id(),
    kind: "table",
    x: 0,
    y: 0,
    columnWidth: size * 2,
    height: size * 2,
    columns: 3,
    headerHeight: size,
    columnOffsets: [0, size],
    pivot: { x: size * 3, y: size },
    style: outline,
  });
  return elements;
}
