import {
  canonicalizeGeometryNumber,
  type ColorV1,
  type EndpointConnectionV1,
  type InkElementV1,
  type InkSnapshotV1,
  type OutlineStyleV1,
  type PageV1,
  type PointV1,
  type ShapeAnchorV1,
  type ShapeStyleV1,
  type StrokeStyleV1,
  type TableElementV1,
} from "../../../domain/schema/public";
import { copyValidatedSampleExtrema } from "../../../domain/schema/stroke-sample-extrema";

interface CanonicalElementBase {
  readonly createdAt: number;
  readonly id: string;
  readonly kind: InkElementV1["kind"];
  readonly pivot: PointV1;
  readonly rotation: number;
}

export function canonicalSnapshot(
  snapshot: InkSnapshotV1,
  preserveRuntimeStrokeBuffers = false,
  copyRuntimeStrokeBuffers = false,
): InkSnapshotV1 {
  return {
    format: "inkbook",
    version: 1,
    revision: snapshot.revision,
    page: canonicalPage(snapshot.page),
    elements: snapshot.elements.map((element) =>
      canonicalElement(element, preserveRuntimeStrokeBuffers, copyRuntimeStrokeBuffers),
    ),
  };
}

export function canonicalPage(page: PageV1): PageV1 {
  let background: PageV1["background"];
  if (page.background.type === "none") background = { type: "none" };
  else if (page.background.type === "lines") {
    background = { type: "lines", spacing: page.background.spacing };
  } else if (page.background.type === "dots") {
    background = { type: "dots", spacing: page.background.spacing };
  } else {
    background = { type: "squares", spacing: page.background.spacing };
  }
  return {
    innerWidth: 2000,
    margin: 24.3,
    background,
    activeBufferLines: page.activeBufferLines,
    lockedBufferLines: page.lockedBufferLines,
  };
}

export function canonicalElement(
  element: InkElementV1,
  preserveRuntimeStrokeBuffers = false,
  copyRuntimeStrokeBuffers = false,
): InkElementV1 {
  const base = {
    kind: element.kind,
    id: element.id,
    createdAt: element.createdAt,
    rotation: element.rotation,
    pivot: canonicalPoint(element.pivot),
  };
  if (element.kind === "stroke") {
    return {
      ...base,
      kind: "stroke",
      tool: element.tool,
      ...(element.offset === undefined ? {} : { offset: canonicalPoint(element.offset) }),
      points:
        preserveRuntimeStrokeBuffers && element.points instanceof Float64Array
          ? runtimeSamples(element.points, copyRuntimeStrokeBuffers)
          : [...element.points],
      style: canonicalStrokeStyle(element.style),
    };
  }
  if (element.kind === "line") {
    return {
      ...base,
      kind: "line",
      ...canonicalConnectedLinear(element),
      startNode: element.startNode,
      endNode: element.endNode,
    };
  }
  if (element.kind === "arrow") {
    return {
      ...base,
      kind: "arrow",
      ...canonicalConnectedLinear(element),
      startNode: element.startNode,
      endNode: element.endNode,
    };
  }
  if (element.kind === "straight-highlighter") {
    return {
      ...base,
      kind: "straight-highlighter",
      start: canonicalPoint(element.start),
      end: canonicalPoint(element.end),
      bend: element.bend === null ? null : canonicalPoint(element.bend),
      startNode: "none",
      endNode: "none",
      style: canonicalStrokeStyle(element.style),
    };
  }
  if (element.kind === "coordinate-system") {
    const axes = element.axes.map(canonicalPoint);
    return element.dimension === "2d"
      ? {
          ...base,
          kind: "coordinate-system",
          origin: canonicalPoint(element.origin),
          dimension: "2d",
          axes: [axes[0]!, axes[1]!],
          style: canonicalOutlineStyle(element.style),
        }
      : {
          ...base,
          kind: "coordinate-system",
          origin: canonicalPoint(element.origin),
          dimension: "3d",
          axes: [axes[0]!, axes[1]!, axes[2]!],
          style: canonicalOutlineStyle(element.style),
        };
  }
  if (element.kind === "table") {
    return canonicalTable(element, base);
  }
  return {
    ...base,
    kind: element.kind,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    style: canonicalShapeStyle(element.style),
  };
}

function runtimeSamples<T extends Float64Array>(points: T, copy: boolean): T {
  if (!copy) return points;
  const owned = new Float64Array(points);
  copyValidatedSampleExtrema(points, owned);
  return owned as T;
}

function canonicalTable(element: TableElementV1, base: CanonicalElementBase): TableElementV1 {
  return {
    ...base,
    kind: "table",
    x: element.x,
    y: element.y,
    columnWidth: element.columnWidth,
    ...(element.columnOffsets === undefined
      ? {}
      : {
          columnOffsets: element.columnOffsets.map((offset) => canonicalizeGeometryNumber(offset)),
        }),
    height: element.height,
    columns: element.columns,
    headerHeight: element.headerHeight,
    style: canonicalOutlineStyle(element.style),
  };
}

function canonicalConnectedLinear(element: Extract<InkElementV1, { kind: "arrow" | "line" }>) {
  return {
    start: canonicalPoint(element.start),
    end: canonicalPoint(element.end),
    bend: element.bend === null ? null : canonicalPoint(element.bend),
    style: canonicalOutlineStyle(element.style),
    startConnection: canonicalConnection(element.startConnection),
    endConnection: canonicalConnection(element.endConnection),
  };
}

function canonicalPoint(point: { readonly x: number; readonly y: number }): {
  x: number;
  y: number;
} {
  return { x: point.x, y: point.y };
}

function canonicalColor(color: ColorV1): ColorV1 {
  return color.type === "theme-text"
    ? { type: "theme-text" }
    : { type: "rgba", value: color.value };
}

function canonicalStrokeStyle(style: StrokeStyleV1): StrokeStyleV1 {
  return {
    color: canonicalColor(style.color),
    width: style.width,
    opacity: style.opacity,
    pressureEnabled: style.pressureEnabled,
    smoothing: 0.5,
  };
}

function canonicalOutlineStyle(style: OutlineStyleV1): OutlineStyleV1 {
  return {
    outlineColor: canonicalColor(style.outlineColor),
    outlineWidth: style.outlineWidth,
    outlineOpacity: style.outlineOpacity,
    outlineStyle: style.outlineStyle,
  };
}

function canonicalShapeStyle(style: ShapeStyleV1): ShapeStyleV1 {
  return {
    ...canonicalOutlineStyle(style),
    fillColor: style.fillColor === null ? null : canonicalColor(style.fillColor),
    fillOpacity: style.fillOpacity,
  };
}

function canonicalConnection(connection: EndpointConnectionV1 | null): EndpointConnectionV1 | null {
  return connection === null
    ? null
    : { targetId: connection.targetId, anchor: canonicalAnchor(connection.anchor) };
}

function canonicalAnchor(anchor: ShapeAnchorV1): ShapeAnchorV1 {
  if (anchor.kind === "box") return { kind: "box", position: anchor.position };
  if (anchor.kind === "ellipse-cardinal") {
    return { kind: "ellipse-cardinal", angle: anchor.angle };
  }
  if (anchor.kind === "coordinate-origin") return { kind: "coordinate-origin" };
  if (anchor.kind === "linear-endpoint") {
    return { endpoint: anchor.endpoint, kind: "linear-endpoint" };
  }
  return { kind: anchor.kind, index: anchor.index };
}
