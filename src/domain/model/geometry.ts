import type { ElementId, NotePointV1, NoteVectorV1 } from "./scalars";
import { createNotePointV1, createNoteVectorV1 } from "./scalars";

interface EncodedStrokeV1 {
  readonly codec: "delta-varint-v1";
  readonly pointCount: number;
  readonly originXQ: number;
  readonly originYQ: number;
  readonly pressure: "absent" | "present";
  readonly data: string;
}

export interface StrokeGeometryV1 {
  readonly stroke: EncodedStrokeV1;
  readonly selectionRotationRadians: number;
}

export interface AreaGeometryV1 {
  readonly center: NotePointV1;
  readonly width: number;
  readonly height: number;
  readonly rotationRadians: number;
}

export type ObjectPortIdV1 =
  | "area:north"
  | "area:east"
  | "area:south"
  | "area:west"
  | "axes:origin"
  | "axes:x-positive"
  | "axes:y-positive"
  | "axes:z-positive";

export interface ObjectPortAttachmentV1 {
  readonly targetElementId: ElementId;
  readonly portId: ObjectPortIdV1;
}

export interface LinearEndpointV1 {
  readonly fallbackPoint: NotePointV1;
  readonly attachment: ObjectPortAttachmentV1 | null;
}

export interface LinearGeometryV1 {
  readonly start: LinearEndpointV1;
  readonly end: LinearEndpointV1;
  readonly control: NotePointV1 | null;
}

export interface TableGeometryV1 extends AreaGeometryV1 {
  readonly rowDividerOffsets: readonly number[];
  readonly columnDividerOffsets: readonly number[];
}

export interface Axes2DGeometryV1 {
  readonly origin: NotePointV1;
  readonly xAxis: NoteVectorV1;
  readonly yAxis: NoteVectorV1;
  readonly gridDivisions: number;
}

export interface Axes3DGeometryV1 extends Axes2DGeometryV1 {
  readonly zAxis: NoteVectorV1;
}

export type NonLinearGeometryV1 =
  | StrokeGeometryV1
  | AreaGeometryV1
  | TableGeometryV1
  | Axes2DGeometryV1
  | Axes3DGeometryV1;

export type CanonicalGeometryV1 = NonLinearGeometryV1 | LinearGeometryV1;

export function materializeStrokeGeometryV1(
  geometry: StrokeGeometryV1,
): StrokeGeometryV1 {
  return Object.freeze({
    ...geometry,
    stroke: Object.freeze({ ...geometry.stroke }),
  });
}

export function materializeAreaGeometryV1(
  geometry: AreaGeometryV1,
): AreaGeometryV1 {
  return Object.freeze({
    ...geometry,
    center: createNotePointV1(geometry.center.x, geometry.center.y),
  });
}

function materializeAttachment(
  attachment: ObjectPortAttachmentV1 | null,
): ObjectPortAttachmentV1 | null {
  return attachment === null ? null : Object.freeze({ ...attachment });
}

function materializeEndpoint(endpoint: LinearEndpointV1): LinearEndpointV1 {
  return Object.freeze({
    fallbackPoint: createNotePointV1(
      endpoint.fallbackPoint.x,
      endpoint.fallbackPoint.y,
    ),
    attachment: materializeAttachment(endpoint.attachment),
  });
}

export function materializeLinearGeometryV1(
  geometry: LinearGeometryV1,
): LinearGeometryV1 {
  return Object.freeze({
    start: materializeEndpoint(geometry.start),
    end: materializeEndpoint(geometry.end),
    control:
      geometry.control === null
        ? null
        : createNotePointV1(geometry.control.x, geometry.control.y),
  });
}

export function materializeTableGeometryV1(
  geometry: TableGeometryV1,
): TableGeometryV1 {
  return Object.freeze({
    ...geometry,
    center: createNotePointV1(geometry.center.x, geometry.center.y),
    rowDividerOffsets: Object.freeze([...geometry.rowDividerOffsets]),
    columnDividerOffsets: Object.freeze([...geometry.columnDividerOffsets]),
  });
}

export function materializeAxes2DGeometryV1(
  geometry: Axes2DGeometryV1,
): Axes2DGeometryV1 {
  return Object.freeze({
    ...geometry,
    origin: createNotePointV1(geometry.origin.x, geometry.origin.y),
    xAxis: createNoteVectorV1(geometry.xAxis.x, geometry.xAxis.y),
    yAxis: createNoteVectorV1(geometry.yAxis.x, geometry.yAxis.y),
  });
}

export function materializeAxes3DGeometryV1(
  geometry: Axes3DGeometryV1,
): Axes3DGeometryV1 {
  return Object.freeze({
    ...materializeAxes2DGeometryV1(geometry),
    zAxis: createNoteVectorV1(geometry.zAxis.x, geometry.zAxis.y),
  });
}
