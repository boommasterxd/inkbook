import type { ElementBinding } from "./bindings";
import { materializeElementBinding } from "./bindings";
import type {
  AreaGeometryV1,
  Axes2DGeometryV1,
  Axes3DGeometryV1,
  LinearGeometryV1,
  StrokeGeometryV1,
  TableGeometryV1,
} from "./geometry";
import {
  materializeAreaGeometryV1,
  materializeAxes2DGeometryV1,
  materializeAxes3DGeometryV1,
  materializeLinearGeometryV1,
  materializeStrokeGeometryV1,
  materializeTableGeometryV1,
} from "./geometry";
import type {
  BindingRevision,
  ElementId,
  GeometryRevision,
  StyleRevision,
} from "./scalars";
import type {
  ConstructionStyleV1,
  HighlighterStyleV1,
  LinearStyleV1,
  PenStyleV1,
  ShapeStyleV1,
} from "./styles";
import {
  materializeConstructionStyleV1,
  materializeHighlighterStyleV1,
  materializeLinearStyleV1,
  materializePenStyleV1,
  materializeShapeStyleV1,
} from "./styles";

export interface ElementCommonV1 {
  readonly elementId: ElementId;
  readonly geometryRevision: GeometryRevision;
  readonly styleRevision: StyleRevision;
  readonly bindingRevision: BindingRevision;
  readonly binding: ElementBinding;
}

export interface PenElementV1 extends ElementCommonV1 {
  readonly kind: "pen";
  readonly geometry: StrokeGeometryV1;
  readonly style: PenStyleV1;
}

interface HighlighterElementV1 extends ElementCommonV1 {
  readonly kind: "highlighter";
  readonly geometry: StrokeGeometryV1;
  readonly style: HighlighterStyleV1;
}

export interface ShapeElementV1 extends ElementCommonV1 {
  readonly kind: "rectangle" | "ellipse" | "triangle" | "diamond" | "octagon";
  readonly geometry: AreaGeometryV1;
  readonly style: ShapeStyleV1;
}

export interface LineElementV1 extends ElementCommonV1 {
  readonly kind: "line" | "arrow";
  readonly geometry: LinearGeometryV1;
  readonly style: LinearStyleV1;
}

export interface TableElementV1 extends ElementCommonV1 {
  readonly kind: "table";
  readonly geometry: TableGeometryV1;
  readonly style: ConstructionStyleV1;
}

export interface Axes2DElementV1 extends ElementCommonV1 {
  readonly kind: "axes-2d";
  readonly geometry: Axes2DGeometryV1;
  readonly style: ConstructionStyleV1;
}

export interface Axes3DElementV1 extends ElementCommonV1 {
  readonly kind: "axes-3d";
  readonly geometry: Axes3DGeometryV1;
  readonly style: ConstructionStyleV1;
}

export type SceneElementV1 =
  | PenElementV1
  | HighlighterElementV1
  | ShapeElementV1
  | LineElementV1
  | TableElementV1
  | Axes2DElementV1
  | Axes3DElementV1;

type WithoutComponentRevisionsV1<T> = T extends SceneElementV1
  ? Omit<T, "geometryRevision" | "styleRevision" | "bindingRevision">
  : never;

export type SceneElementValueV1 = WithoutComponentRevisionsV1<SceneElementV1>;

export function materializeSceneElementV1(
  element: SceneElementV1,
): SceneElementV1 {
  switch (element.kind) {
    case "pen":
      return Object.freeze({
        ...element,
        binding: materializeElementBinding(element.binding),
        geometry: materializeStrokeGeometryV1(element.geometry),
        style: materializePenStyleV1(element.style),
      });
    case "highlighter":
      return Object.freeze({
        ...element,
        binding: materializeElementBinding(element.binding),
        geometry: materializeStrokeGeometryV1(element.geometry),
        style: materializeHighlighterStyleV1(element.style),
      });
    case "rectangle":
    case "ellipse":
    case "triangle":
    case "diamond":
    case "octagon":
      return Object.freeze({
        ...element,
        binding: materializeElementBinding(element.binding),
        geometry: materializeAreaGeometryV1(element.geometry),
        style: materializeShapeStyleV1(element.style),
      });
    case "line":
    case "arrow":
      return Object.freeze({
        ...element,
        binding: materializeElementBinding(element.binding),
        geometry: materializeLinearGeometryV1(element.geometry),
        style: materializeLinearStyleV1(element.style),
      });
    case "table":
      return Object.freeze({
        ...element,
        binding: materializeElementBinding(element.binding),
        geometry: materializeTableGeometryV1(element.geometry),
        style: materializeConstructionStyleV1(element.style),
      });
    case "axes-2d":
      return Object.freeze({
        ...element,
        binding: materializeElementBinding(element.binding),
        geometry: materializeAxes2DGeometryV1(element.geometry),
        style: materializeConstructionStyleV1(element.style),
      });
    case "axes-3d":
      return Object.freeze({
        ...element,
        binding: materializeElementBinding(element.binding),
        geometry: materializeAxes3DGeometryV1(element.geometry),
        style: materializeConstructionStyleV1(element.style),
      });
  }
}
