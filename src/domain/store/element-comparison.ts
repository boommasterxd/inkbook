import type { InkElementV1 } from "../schema/public";

import type { DeltaDomain, ImmutableInkElement } from "./types";

export function elementsEqual(left: ImmutableInkElement, right: InkElementV1): boolean {
  return valuesEqual(left, right);
}

export function classifyReplacement(
  previous: ImmutableInkElement,
  next: InkElementV1,
): DeltaDomain[] {
  const domains: DeltaDomain[] = [];
  if (!geometryEqual(previous, next)) domains.push("geometry");
  if (!paintEqual(previous, next)) domains.push("paint");
  if (!connectionsEqual(previous, next)) domains.push("connection");
  return domains;
}

export function hasConnections(element: ImmutableInkElement | InkElementV1): boolean {
  return (
    (element.kind === "line" || element.kind === "arrow") &&
    (element.startConnection !== null || element.endConnection !== null)
  );
}

function geometryEqual(left: ImmutableInkElement, right: InkElementV1): boolean {
  if (left.kind !== right.kind) return false;
  if (!valuesEqual(left.pivot, right.pivot) || left.rotation !== right.rotation) return false;
  if (!geometryStyleEqual(left, right)) return false;
  switch (left.kind) {
    case "stroke":
      return strokeGeometryEqual(left, right);
    case "line":
    case "arrow":
      return connectedLinearGeometryEqual(left, right);
    case "straight-highlighter":
      return right.kind === "straight-highlighter" && linearGeometryEqual(left, right);
    case "coordinate-system":
      return coordinateGeometryEqual(left, right);
    case "table":
      return tableGeometryEqual(left, right);
    default:
      return boxGeometryEqual(left, right);
  }
}

function strokeGeometryEqual(
  left: Extract<ImmutableInkElement, { kind: "stroke" }>,
  right: InkElementV1,
): boolean {
  return (
    right.kind === "stroke" && left.tool === right.tool && valuesEqual(left.points, right.points)
  );
}

function connectedLinearGeometryEqual(
  left: Extract<ImmutableInkElement, { kind: "line" | "arrow" }>,
  right: InkElementV1,
): boolean {
  return (
    right.kind === left.kind &&
    linearGeometryEqual(left, right) &&
    left.startNode === right.startNode &&
    left.endNode === right.endNode
  );
}

function coordinateGeometryEqual(
  left: Extract<ImmutableInkElement, { kind: "coordinate-system" }>,
  right: InkElementV1,
): boolean {
  return (
    right.kind === "coordinate-system" &&
    left.dimension === right.dimension &&
    valuesEqual(left.origin, right.origin) &&
    valuesEqual(left.axes, right.axes)
  );
}

function tableGeometryEqual(
  left: Extract<ImmutableInkElement, { kind: "table" }>,
  right: InkElementV1,
): boolean {
  return (
    right.kind === "table" &&
    left.x === right.x &&
    left.y === right.y &&
    left.columnWidth === right.columnWidth &&
    valuesEqual(left.columnOffsets, right.columnOffsets) &&
    left.height === right.height &&
    left.columns === right.columns &&
    left.headerHeight === right.headerHeight
  );
}

function boxGeometryEqual(
  left: Exclude<
    ImmutableInkElement,
    { kind: "stroke" | "line" | "arrow" | "straight-highlighter" | "coordinate-system" | "table" }
  >,
  right: InkElementV1,
): boolean {
  return (
    right.kind === left.kind &&
    "x" in right &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function linearGeometryEqual(
  left: Extract<ImmutableInkElement, { kind: "line" | "arrow" | "straight-highlighter" }>,
  right: Extract<InkElementV1, { kind: "line" | "arrow" | "straight-highlighter" }>,
): boolean {
  return (
    valuesEqual(left.start, right.start) &&
    valuesEqual(left.end, right.end) &&
    valuesEqual(left.bend, right.bend)
  );
}

function geometryStyleEqual(left: ImmutableInkElement, right: InkElementV1): boolean {
  if (left.kind === "stroke" || left.kind === "straight-highlighter") {
    if (right.kind !== "stroke" && right.kind !== "straight-highlighter") return false;
    return (
      left.style.width === right.style.width &&
      left.style.pressureEnabled === right.style.pressureEnabled &&
      left.style.smoothing === right.style.smoothing
    );
  }
  if (right.kind === "stroke" || right.kind === "straight-highlighter") return false;
  return left.style.outlineWidth === right.style.outlineWidth;
}

function paintEqual(left: ImmutableInkElement, right: InkElementV1): boolean {
  if (left.kind === "stroke" || left.kind === "straight-highlighter") {
    if (right.kind !== "stroke" && right.kind !== "straight-highlighter") return false;
    return (
      valuesEqual(left.style.color, right.style.color) && left.style.opacity === right.style.opacity
    );
  }
  if (right.kind === "stroke" || right.kind === "straight-highlighter") return false;
  if (
    !valuesEqual(left.style.outlineColor, right.style.outlineColor) ||
    left.style.outlineOpacity !== right.style.outlineOpacity ||
    left.style.outlineStyle !== right.style.outlineStyle
  )
    return false;
  if (!("fillColor" in left.style) || !("fillColor" in right.style)) {
    return !("fillColor" in left.style) && !("fillColor" in right.style);
  }
  return (
    valuesEqual(left.style.fillColor, right.style.fillColor) &&
    left.style.fillOpacity === right.style.fillOpacity
  );
}

function connectionsEqual(left: ImmutableInkElement, right: InkElementV1): boolean {
  if (left.kind !== "line" && left.kind !== "arrow") {
    return right.kind !== "line" && right.kind !== "arrow";
  }
  if (right.kind !== left.kind) return false;
  return (
    valuesEqual(left.startConnection, right.startConnection) &&
    valuesEqual(left.endConnection, right.endConnection)
  );
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Float64Array && right instanceof Float64Array) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((value, index) => valuesEqual(value, right[index]));
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftEntries = Object.entries(left);
  const rightRecord = right as Record<string, unknown>;
  return (
    leftEntries.length === Object.keys(rightRecord).length &&
    leftEntries.every(([key, value]) => valuesEqual(value, rightRecord[key]))
  );
}
