import type { MutableSceneInstrumentation, SceneElementRecord } from "../types";
import type { SvgPathPart } from "../../../domain/geometry/element-path";
import { SVG_NAMESPACE } from "../constants";
import {
  scaledDashPattern,
  scaledStrokeWidth,
  PRESENTATION_ATTRIBUTES,
  pathPresentation,
  type PathPresentation,
  type PresentationAttribute,
} from "./element-presentation";

export interface MountedPath {
  appliedD: string;
  appliedPresentation: PathPresentation;
  appliedPreviewStrokeWidthScale: number | null;
  appliedTransform: string | null;
  readonly node: SVGPathElement;
}

export function createMountedPath(
  ownerDocument: Document,
  record: SceneElementRecord,
  part: SvgPathPart,
  instrumentation: MutableSceneInstrumentation,
): MountedPath {
  const node = ownerDocument.createElementNS(SVG_NAMESPACE, "path");
  const presentation = pathPresentation(record.element, part);
  const mounted: MountedPath = {
    appliedD: "",
    appliedPresentation: presentation,
    appliedPreviewStrokeWidthScale: null,
    appliedTransform: null,
    node,
  };
  writeAttribute(mounted, "d", part.d, instrumentation, true);
  for (const attribute of PRESENTATION_ATTRIBUTES) {
    const value = presentation[attribute];
    if (value !== null) writeRaw(node, attribute, value, instrumentation, false);
  }
  return mounted;
}

export function writePresentation(
  path: MountedPath,
  attribute: PresentationAttribute,
  value: string | null,
  instrumentation: MutableSceneInstrumentation,
): void {
  if (path.appliedPresentation[attribute] === value) return;
  let appliedValue = value;
  if (path.appliedPreviewStrokeWidthScale !== null) {
    if (attribute === "stroke-width") {
      appliedValue = scaledStrokeWidth(value, path.appliedPreviewStrokeWidthScale);
    } else if (attribute === "stroke-dasharray") {
      appliedValue = scaledDashPattern(value, path.appliedPreviewStrokeWidthScale);
    }
  }
  writeRaw(path.node, attribute, appliedValue, instrumentation, false);
}

export function writePreviewStrokeWidth(
  path: MountedPath,
  scale: number | null,
  instrumentation: MutableSceneInstrumentation,
): void {
  const strokeWidth = path.appliedPresentation["stroke-width"];
  const appliedScale = strokeWidth === null ? null : scale;
  if (path.appliedPreviewStrokeWidthScale === appliedScale) return;
  if (appliedScale === null) {
    if (path.appliedPreviewStrokeWidthScale !== null) {
      writeRaw(path.node, "vector-effect", null, instrumentation, false);
      if (strokeWidth !== null) {
        writeRaw(path.node, "stroke-width", strokeWidth, instrumentation, false);
      }
    }
  } else {
    if (path.appliedPreviewStrokeWidthScale === null) {
      writeRaw(path.node, "vector-effect", "non-scaling-stroke", instrumentation, false);
    }
    writeRaw(
      path.node,
      "stroke-width",
      scaledStrokeWidth(strokeWidth, appliedScale),
      instrumentation,
      false,
    );
  }
  const dash = path.appliedPresentation["stroke-dasharray"];
  if (dash !== null) {
    writeRaw(
      path.node,
      "stroke-dasharray",
      scaledDashPattern(dash, appliedScale ?? 1),
      instrumentation,
      false,
    );
  }
  path.appliedPreviewStrokeWidthScale = appliedScale;
}

export function writeAttribute(
  path: MountedPath,
  attribute: "d" | "transform",
  value: string | null,
  instrumentation: MutableSceneInstrumentation,
  geometry: boolean,
): void {
  const current = attribute === "d" ? path.appliedD : path.appliedTransform;
  if (current === value) return;
  writeRaw(path.node, attribute, value, instrumentation, geometry);
  if (attribute === "d") path.appliedD = value ?? "";
  else path.appliedTransform = value;
}

export function writeRaw(
  node: SVGElement,
  attribute: string,
  value: string | null,
  instrumentation: MutableSceneInstrumentation,
  geometry: boolean,
): void {
  if (value === null) node.removeAttribute(attribute);
  else if (attribute === "xml:space")
    node.setAttributeNS("http://www.w3.org/XML/1998/namespace", attribute, value);
  else node.setAttribute(attribute, value);
  instrumentation.attributeWrites += 1;
  instrumentation.contentAttributeWrites += 1;
  if (geometry) instrumentation.contentGeometryWrites += 1;
}
