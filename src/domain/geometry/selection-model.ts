import type {
  ElementId,
  NotePointV1,
  SceneElementV1,
  TableElementV1,
} from "../model";
import { deriveAxisSelectionModelV1 } from "./axis-selection";
import { resolveLinearEndpointsV1 } from "./object-ports";
import type { ElementLookupV1 } from "./object-ports";
import type { GeometryProjectionV1, GeometryResultV1 } from "./projection";
import {
  geometryFailureV1,
  geometrySuccessV1,
  isFiniteAreaV1,
  isFinitePointV1,
  materializeGeometryPointV1,
  validateProjectionV1,
} from "./projection";
import {
  createAreaHandlesV1,
  createOrientedFrameV1,
  rotateHandlePointV1,
  transformFramePointV1,
} from "./selection-frames";
import type {
  AreaSelectionModelV1,
  ElementSelectionModelV1,
  LinearEndpointHandleV1,
  LinearSelectionModelV1,
  OrientedSelectionFrameV1,
  TableDividerHandleV1,
} from "./selection-types";

type StrokePointSourceV1 = (
  elementId: ElementId,
) => readonly NotePointV1[] | undefined;

export interface SelectionDerivationContextV1 {
  readonly getElement: ElementLookupV1;
  readonly getStrokePoints: StrokePointSourceV1;
  readonly projection: GeometryProjectionV1;
}

const HALF = 2;

function anchorHandle(
  element: SceneElementV1,
  point: NotePointV1,
): LinearSelectionModelV1["anchorHandle"] {
  return Object.freeze({ point, bindingKind: element.binding.kind });
}

function deriveLinearSelection(
  element: SceneElementV1,
  context: SelectionDerivationContextV1,
): GeometryResultV1<LinearSelectionModelV1> {
  if (element.kind !== "line" && element.kind !== "arrow") {
    return geometryFailureV1("target-kind-unsupported");
  }
  const endpoints = resolveLinearEndpointsV1({
    element,
    getElement: context.getElement,
    projection: context.projection,
  });
  if (!endpoints.ok) {
    return endpoints;
  }
  const start: LinearEndpointHandleV1 = Object.freeze({
    endpoint: "start",
    point: endpoints.value.start,
    attached: element.geometry.start.attachment !== null,
  });
  const end: LinearEndpointHandleV1 = Object.freeze({
    endpoint: "end",
    point: endpoints.value.end,
    attached: element.geometry.end.attachment !== null,
  });
  const canonicalControl = element.geometry.control;
  const projectedControl =
    canonicalControl === null
      ? {
          x: (start.point.x + end.point.x) / HALF,
          y: (start.point.y + end.point.y) / HALF,
        }
      : context.projection.projectPoint(element, canonicalControl);
  if (projectedControl === null || !isFinitePointV1(projectedControl)) {
    return geometryFailureV1("projection-invalid");
  }
  const center = materializeGeometryPointV1({
    x: (start.point.x + end.point.x) / HALF,
    y: (start.point.y + end.point.y) / HALF,
  });
  const endpointHandles = Object.freeze([start, end] as const);
  return geometrySuccessV1(
    Object.freeze({
      kind: "linear",
      elementId: element.elementId,
      endpoints: endpointHandles,
      curveHandle: materializeGeometryPointV1(projectedControl),
      attachmentIndicators: Object.freeze(
        endpointHandles.filter((handle) => handle.attached),
      ),
      anchorHandle: anchorHandle(element, center),
      geometryTransformAllowed: element.binding.kind !== "text-range",
    }),
  );
}

function projectedAreaFrame(
  element: SceneElementV1,
  projection: GeometryProjectionV1,
): GeometryResultV1<OrientedSelectionFrameV1> {
  if (
    element.kind !== "rectangle" &&
    element.kind !== "ellipse" &&
    element.kind !== "triangle" &&
    element.kind !== "diamond" &&
    element.kind !== "octagon" &&
    element.kind !== "table"
  ) {
    return geometryFailureV1("target-kind-unsupported");
  }
  const area = projection.projectArea(element, element.geometry);
  return area !== null && isFiniteAreaV1(area)
    ? geometrySuccessV1(
        Object.freeze({
          center: materializeGeometryPointV1(area.center),
          width: area.width,
          height: area.height,
          rotationRadians: area.rotationRadians,
        }),
      )
    : geometryFailureV1("projection-invalid");
}

function strokeFrame(
  element: SceneElementV1,
  context: SelectionDerivationContextV1,
): GeometryResultV1<OrientedSelectionFrameV1> {
  if (element.kind !== "pen" && element.kind !== "highlighter") {
    return geometryFailureV1("target-kind-unsupported");
  }
  const points = context.getStrokePoints(element.elementId);
  if (points === undefined || points.length === 0) {
    return geometryFailureV1("stroke-points-unavailable");
  }
  const projected = context.projection.projectStroke(element, points);
  if (
    projected === null ||
    projected.some((point) => !isFinitePointV1(point))
  ) {
    return geometryFailureV1("projection-invalid");
  }
  const frame = createOrientedFrameV1(
    projected,
    element.geometry.selectionRotationRadians,
  );
  return frame === null
    ? geometryFailureV1("projection-invalid")
    : geometrySuccessV1(frame);
}

function tableDividerHandles(
  element: TableElementV1,
  frame: OrientedSelectionFrameV1,
): readonly TableDividerHandleV1[] {
  const rowScale = frame.height / element.geometry.height;
  const columnScale = frame.width / element.geometry.width;
  const halfWidth = frame.width / HALF;
  const halfHeight = frame.height / HALF;
  const rows = element.geometry.rowDividerOffsets.map((offset, index) => {
    const y = offset * rowScale;
    return Object.freeze({
      axis: "row" as const,
      index,
      point: transformFramePointV1(frame, { x: 0, y }),
      corridor: Object.freeze([
        transformFramePointV1(frame, { x: -halfWidth, y }),
        transformFramePointV1(frame, { x: halfWidth, y }),
      ] as const),
    });
  });
  const columns = element.geometry.columnDividerOffsets.map((offset, index) => {
    const x = offset * columnScale;
    return Object.freeze({
      axis: "column" as const,
      index,
      point: transformFramePointV1(frame, { x, y: 0 }),
      corridor: Object.freeze([
        transformFramePointV1(frame, { x, y: -halfHeight }),
        transformFramePointV1(frame, { x, y: halfHeight }),
      ] as const),
    });
  });
  return Object.freeze([...rows, ...columns]);
}

function deriveAreaSelection(
  element: SceneElementV1,
  context: SelectionDerivationContextV1,
): GeometryResultV1<AreaSelectionModelV1> {
  const frameResult =
    element.kind === "pen" || element.kind === "highlighter"
      ? strokeFrame(element, context)
      : projectedAreaFrame(element, context.projection);
  if (!frameResult.ok) {
    return frameResult;
  }
  const frame = frameResult.value;
  const restricted = element.binding.kind === "text-range";
  const isStroke = element.kind === "pen" || element.kind === "highlighter";
  const disabledStrokeAxes = Object.freeze({
    x: isStroke && frame.width === 0,
    y: isStroke && frame.height === 0,
  });
  const dividerHandles =
    element.kind === "table" && !restricted
      ? tableDividerHandles(element, frame)
      : Object.freeze([]);
  return geometrySuccessV1(
    Object.freeze({
      kind: "area",
      elementId: element.elementId,
      frame,
      resizeHandles: restricted
        ? Object.freeze([])
        : createAreaHandlesV1(frame, disabledStrokeAxes),
      rotateHandle: restricted ? null : rotateHandlePointV1(frame),
      dividerHandles,
      disabledStrokeAxes,
      anchorHandle: anchorHandle(element, frame.center),
      geometryTransformAllowed: !restricted,
    }),
  );
}

export function deriveElementSelectionModelV1(
  element: SceneElementV1,
  context: SelectionDerivationContextV1,
): GeometryResultV1<ElementSelectionModelV1> {
  const projection = validateProjectionV1(context.projection);
  if (!projection.ok) {
    return projection;
  }
  switch (element.kind) {
    case "line":
    case "arrow":
      return deriveLinearSelection(element, context);
    case "axes-2d":
    case "axes-3d":
      return deriveAxisSelectionModelV1(element, context.projection);
    default:
      return deriveAreaSelection(element, context);
  }
}
