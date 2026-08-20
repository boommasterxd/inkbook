import type { ElementId, NotePointV1 } from "../model";

export interface OrientedSelectionFrameV1 {
  readonly center: NotePointV1;
  readonly width: number;
  readonly height: number;
  readonly rotationRadians: number;
}

export type AreaHandleIdV1 =
  | "north-west"
  | "north"
  | "north-east"
  | "east"
  | "south-east"
  | "south"
  | "south-west"
  | "west";

export interface AreaSelectionHandleV1 {
  readonly id: AreaHandleIdV1;
  readonly point: NotePointV1;
  readonly enabled: boolean;
}

interface AnchorSelectionHandleV1 {
  readonly point: NotePointV1;
  readonly bindingKind: "fixed" | "text-position" | "text-range";
}

export interface LinearEndpointHandleV1 {
  readonly endpoint: "start" | "end";
  readonly point: NotePointV1;
  readonly attached: boolean;
}

export interface LinearSelectionModelV1 {
  readonly kind: "linear";
  readonly elementId: ElementId;
  readonly endpoints: readonly [LinearEndpointHandleV1, LinearEndpointHandleV1];
  readonly curveHandle: NotePointV1;
  readonly attachmentIndicators: readonly LinearEndpointHandleV1[];
  readonly anchorHandle: AnchorSelectionHandleV1;
  readonly geometryTransformAllowed: boolean;
}

export interface TableDividerHandleV1 {
  readonly axis: "row" | "column";
  readonly index: number;
  readonly point: NotePointV1;
  readonly corridor: readonly [NotePointV1, NotePointV1];
}

export interface AreaSelectionModelV1 {
  readonly kind: "area";
  readonly elementId: ElementId;
  readonly frame: OrientedSelectionFrameV1;
  readonly resizeHandles: readonly AreaSelectionHandleV1[];
  readonly rotateHandle: NotePointV1 | null;
  readonly dividerHandles: readonly TableDividerHandleV1[];
  readonly disabledStrokeAxes: Readonly<{
    x: boolean;
    y: boolean;
  }>;
  readonly anchorHandle: AnchorSelectionHandleV1;
  readonly geometryTransformAllowed: boolean;
}

export interface AxisSelectionControlV1 {
  readonly axis: "x" | "y" | "z";
  readonly start: NotePointV1;
  readonly end: NotePointV1;
  readonly lengthHandle: NotePointV1;
  readonly controlBound: Readonly<{
    center: NotePointV1;
    length: number;
    rotationRadians: number;
  }>;
}

export interface AxisSetSelectionModelV1 {
  readonly kind: "axis-set";
  readonly elementId: ElementId;
  readonly axes: readonly AxisSelectionControlV1[];
  readonly moveTarget: NotePointV1;
  readonly rotateHandle: NotePointV1;
  readonly rotationRadians: number;
  readonly anchorHandle: AnchorSelectionHandleV1;
  readonly geometryTransformAllowed: boolean;
}

export interface AggregateSelectionModelV1 {
  readonly kind: "aggregate";
  readonly frame: OrientedSelectionFrameV1;
  readonly resizeHandles: readonly AreaSelectionHandleV1[];
  readonly rotateHandle: NotePointV1 | null;
  readonly anchorHandle: NotePointV1;
  readonly geometryTransformAllowed: boolean;
  readonly persistedOrientation: boolean;
}

export type ElementSelectionModelV1 =
  LinearSelectionModelV1 | AreaSelectionModelV1 | AxisSetSelectionModelV1;
