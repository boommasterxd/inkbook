export interface InkSnapshotV1 {
  format: "inkbook";
  version: 1;
  revision: number;
  page: PageV1;
  elements: InkElementV1[];
}

export interface PageV1 {
  innerWidth: 2000;
  margin: 24.3;
  background: BackgroundV1;
  activeBufferLines: number;
  lockedBufferLines: number;
}

export type BackgroundV1 =
  | { type: "none" }
  | { type: "lines"; spacing: 25 | 33.333333333333336 | 50 | 100 }
  | { type: "dots"; spacing: 25 | 33.333333333333336 | 50 | 100 }
  | { type: "squares"; spacing: 25 | 33.333333333333336 | 50 | 100 };

export interface PointV1 {
  x: number;
  y: number;
}

export type StrokeSamplesV1 = number[];

export type ColorV1 = { type: "theme-text" } | { type: "rgba"; value: `#${string}` };

interface ElementBaseV1 {
  id: string;
  createdAt: number;
  rotation: number;
  pivot: PointV1;
}

export interface StrokeStyleV1 {
  color: ColorV1;
  width: 2 | 4 | 8 | 14 | 22;
  opacity: number;
  pressureEnabled: boolean;
  smoothing: 0.5;
}

export interface OutlineStyleV1 {
  outlineColor: ColorV1;
  outlineWidth: 1 | 2 | 4 | 8 | 12;
  outlineOpacity: number;
  outlineStyle: "solid" | "dashed" | "dotted";
}

export interface ShapeStyleV1 extends OutlineStyleV1 {
  fillColor: ColorV1 | null;
  fillOpacity: number;
}

export interface StrokeElementV1 extends ElementBaseV1 {
  kind: "stroke";
  tool: "pen" | "highlighter";
  points: StrokeSamplesV1;
  style: StrokeStyleV1;
}

interface LinearBaseV1 extends ElementBaseV1 {
  start: PointV1;
  end: PointV1;
  bend: PointV1 | null;
}

export interface EndpointConnectionV1 {
  targetId: string;
  anchor: ShapeAnchorV1;
}

export type BoxAnchorV1 =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-right"
  | "bottom-right"
  | "bottom-center"
  | "bottom-left"
  | "middle-left";

export type ShapeAnchorV1 =
  | { kind: "box"; position: BoxAnchorV1 }
  | { kind: "ellipse-cardinal"; angle: 0 | 90 | 180 | 270 }
  | { kind: "polygon-vertex"; index: number }
  | { kind: "polygon-edge-midpoint"; index: number }
  | { kind: "coordinate-origin" }
  | { kind: "coordinate-axis-end"; index: number }
  | { kind: "linear-endpoint"; endpoint: "start" | "end" };

interface ConnectableLinearBaseV1 extends LinearBaseV1 {
  startConnection: EndpointConnectionV1 | null;
  endConnection: EndpointConnectionV1 | null;
}

export interface LineElementV1 extends ConnectableLinearBaseV1 {
  kind: "line";
  startNode: "none";
  endNode: "none";
  style: OutlineStyleV1;
}

export type ArrowNodeV1 = "none" | "arrow" | "triangle" | "diamond" | "circle";

export interface ArrowElementV1 extends ConnectableLinearBaseV1 {
  kind: "arrow";
  startNode: ArrowNodeV1;
  endNode: ArrowNodeV1;
  style: OutlineStyleV1;
}

export interface StraightHighlighterElementV1 extends LinearBaseV1 {
  kind: "straight-highlighter";
  startNode: "none";
  endNode: "none";
  style: StrokeStyleV1;
}

export type LinearElementV1 = LineElementV1 | ArrowElementV1 | StraightHighlighterElementV1;

type BoxShapeKindV1 =
  "rectangle" | "ellipse" | "triangle" | "octagon" | "parallelogram" | "diamond";

interface BoxShapeBaseV1 extends ElementBaseV1 {
  x: number;
  y: number;
  width: number;
  height: number;
  style: ShapeStyleV1;
}

export type BoxShapeElementV1 = {
  [Kind in BoxShapeKindV1]: BoxShapeBaseV1 & { kind: Kind };
}[BoxShapeKindV1];

interface CoordinateSystemBaseV1 extends ElementBaseV1 {
  kind: "coordinate-system";
  origin: PointV1;
  style: OutlineStyleV1;
}

export type CoordinateSystemElementV1 = CoordinateSystemBaseV1 &
  (
    | { dimension: "2d"; axes: [PointV1, PointV1] }
    | { dimension: "3d"; axes: [PointV1, PointV1, PointV1] }
  );

export interface TableElementV1 extends ElementBaseV1 {
  kind: "table";
  x: number;
  y: number;
  columnWidth: number;
  columnOffsets?: number[];
  height: number;
  columns: number;
  headerHeight: number;
  style: OutlineStyleV1;
}

export type InkElementV1 =
  | StrokeElementV1
  | LinearElementV1
  | BoxShapeElementV1
  | CoordinateSystemElementV1
  | TableElementV1;

interface ClipboardEndpointConnectionV1 {
  targetClipId: string;
  anchor: ShapeAnchorV1;
}

export type ClipboardElementBodyV1<T extends InkElementV1 = InkElementV1> = T extends
  LineElementV1 | ArrowElementV1
  ? Omit<T, "id" | "createdAt" | "startConnection" | "endConnection"> & {
      startConnection: ClipboardEndpointConnectionV1 | null;
      endConnection: ClipboardEndpointConnectionV1 | null;
    }
  : Omit<T, "id" | "createdAt">;

export interface ClipboardElementV1 {
  clipId: string;
  element: ClipboardElementBodyV1;
}

export interface InkClipboardV1 {
  format: "inkbook-elements";
  version: 1;
  elements: ClipboardElementV1[];
}
