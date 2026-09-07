import { roundCanonical } from "../../domain/geometry/public";
import type { SvgPathPart } from "../../domain/geometry/element-path";
import { SVG_NAMESPACE } from "./constants";
import {
  PRESENTATION_ATTRIBUTES,
  pathPresentation,
  type PathPresentation,
  type PresentationAttribute,
} from "./element-presentation";
import type { MutableSceneInstrumentation, SceneElementRecord } from "./types";
import { EASING_TOKENS } from "../motion/transitions";
import { clearMotionStyle, writeMotionStyle } from "./motion-visual";

interface MountedPath {
  appliedD: string;
  appliedPresentation: PathPresentation;
  appliedPreviewStrokeWidthScale: number | null;
  appliedTransform: string | null;
  readonly node: SVGPathElement;
}

interface TopologyUpdateOptions {
  readonly instrumentation: MutableSceneInstrumentation;
  readonly ownerDocument: Document;
  readonly parent: SVGGElement;
}

export interface MountedSceneElement {
  band: SceneElementRecord["band"];
  geometryVersion: number;
  readonly id: string;
  paintVersion: number;
  readonly paths: MountedPath[];
  pathParts: readonly SvgPathPart[];
  previewStrokeWidthScale: number | null;
  previewTransformVersion: number;
  rank: number;
}

export function createMountedElement(
  ownerDocument: Document,
  record: SceneElementRecord,
  parts: readonly SvgPathPart[],
  instrumentation: MutableSceneInstrumentation,
): MountedSceneElement {
  const paths = parts.map((part) =>
    createMountedPath(ownerDocument, record, part, instrumentation),
  );
  return {
    band: record.band,
    geometryVersion: record.geometryVersion,
    id: record.id,
    paintVersion: record.paintVersion,
    paths,
    pathParts: parts,
    previewStrokeWidthScale: null,
    previewTransformVersion: 0,
    rank: record.rank,
  };
}

export function appendElementToFragment(
  entry: MountedSceneElement,
  fragment: DocumentFragment,
): void {
  for (const path of entry.paths) fragment.append(path.node);
}

export function removeMountedElement(entry: MountedSceneElement): void {
  for (const path of entry.paths) path.node.remove();
}

export function updateMountedGeometry(
  entry: MountedSceneElement,
  record: SceneElementRecord,
  parts: readonly SvgPathPart[],
  ownerDocument: Document,
  parent: SVGGElement,
  instrumentation: MutableSceneInstrumentation,
): void {
  if (entry.paths.length !== parts.length) {
    replacePathTopology(entry, record, parts, {
      instrumentation,
      ownerDocument,
      parent,
    });
  } else {
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const path = entry.paths[index];
      if (part === undefined || path === undefined) continue;
      writeAttribute(path, "d", part.d, instrumentation, true);
    }
    updateMountedPaint(entry, record, parts, instrumentation);
  }
  entry.pathParts = parts;
  entry.geometryVersion = record.geometryVersion;
  entry.paintVersion = record.paintVersion;
  entry.rank = record.rank;
}

export function updateMountedPaint(
  entry: MountedSceneElement,
  record: SceneElementRecord,
  parts: readonly SvgPathPart[],
  instrumentation: MutableSceneInstrumentation,
): void {
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const path = entry.paths[index];
    if (part === undefined || path === undefined) continue;
    const presentation = pathPresentation(record.element, part);
    for (const attribute of PRESENTATION_ATTRIBUTES) {
      writePresentation(path, attribute, presentation[attribute], instrumentation);
    }
    path.appliedPresentation = presentation;
  }
  entry.paintVersion = record.paintVersion;
  entry.rank = record.rank;
}

export function updatePreviewTransform(
  entry: MountedSceneElement,
  transform: string | null,
  version: number,
  strokeWidthScale: number | null,
  instrumentation: MutableSceneInstrumentation,
): void {
  entry.previewStrokeWidthScale = strokeWidthScale;
  if (
    entry.previewTransformVersion === version &&
    entry.paths.every(
      (path) =>
        path.appliedTransform === transform &&
        path.appliedPreviewStrokeWidthScale ===
          (path.appliedPresentation["stroke-width"] === null ? null : strokeWidthScale),
    )
  ) {
    return;
  }
  for (const path of entry.paths) {
    writeAttribute(path, "transform", transform, instrumentation, true);
    writePreviewStrokeWidth(path, strokeWidthScale, instrumentation);
  }
  entry.previewTransformVersion = version;
}

export function updateMountedElementPreview(
  entry: MountedSceneElement,
  record: SceneElementRecord,
  previewElement: SceneElementRecord["element"],
  parts: readonly SvgPathPart[],
  options: {
    readonly instrumentation: MutableSceneInstrumentation;
    readonly ownerDocument: Document;
    readonly parent: SVGGElement;
  },
): void {
  const original = {
    geometryVersion: entry.geometryVersion,
    paintVersion: entry.paintVersion,
    pathParts: entry.pathParts,
    rank: entry.rank,
  };
  updateMountedPreviewGeometry(entry, { ...record, element: previewElement }, parts, options);
  entry.geometryVersion = original.geometryVersion;
  entry.paintVersion = original.paintVersion;
  entry.pathParts = original.pathParts;
  entry.rank = original.rank;
}

function updateMountedPreviewGeometry(
  entry: MountedSceneElement,
  record: SceneElementRecord,
  parts: readonly SvgPathPart[],
  options: TopologyUpdateOptions,
): void {
  if (entry.paths.length !== parts.length) {
    replacePathTopology(entry, record, parts, options);
    return;
  }
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const path = entry.paths[index];
    if (part !== undefined && path !== undefined) {
      writeAttribute(path, "d", part.d, options.instrumentation, true);
    }
  }
  updateMountedPaint(entry, record, parts, options.instrumentation);
}

export function setMountedElementFade(entry: MountedSceneElement, durationMs: number | null): void {
  for (const path of entry.paths) {
    path.node.style.transition =
      durationMs === null ? "" : `opacity ${String(durationMs)}ms ${EASING_TOKENS.standard}`;
    path.node.style.opacity = durationMs === null ? "" : "0";
  }
}

export function setMountedElementMotion(
  entry: MountedSceneElement,
  opacity: number | null,
  scale = 1,
): void {
  for (const path of entry.paths) {
    if (opacity === null) clearMotionStyle(path.node);
    else writeMotionStyle(path.node, opacity, scale);
  }
}

export function firstPath(entry: MountedSceneElement): SVGElement {
  const path = entry.paths[0];
  if (path === undefined) throw new Error("A mounted element must own at least one path.");
  return path.node;
}

function createMountedPath(
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

function replacePathTopology(
  entry: MountedSceneElement,
  record: SceneElementRecord,
  parts: readonly SvgPathPart[],
  options: TopologyUpdateOptions,
): void {
  const transform = entry.paths[0]?.appliedTransform ?? null;
  const strokeWidthScale = entry.previewStrokeWidthScale;
  const reference = firstPath(entry);
  const fragment = createFragment(options.ownerDocument);
  const paths = parts.map((part) =>
    createMountedPath(options.ownerDocument, record, part, options.instrumentation),
  );
  for (const path of paths) fragment.append(path.node);
  options.parent.insertBefore(fragment, reference);
  for (const path of entry.paths) path.node.remove();
  entry.paths.splice(0, entry.paths.length, ...paths);
  entry.previewStrokeWidthScale = null;
  updatePreviewTransform(
    entry,
    transform,
    entry.previewTransformVersion,
    strokeWidthScale,
    options.instrumentation,
  );
}

function createFragment(ownerDocument: Document): DocumentFragment {
  const create = ownerDocument.createDocumentFragment.bind(ownerDocument);
  return create();
}

function writePresentation(
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

function writePreviewStrokeWidth(
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

function scaledDashPattern(value: string | null, scale: number): string | null {
  return value === null
    ? null
    : value
        .split(" ")
        .map((part) => scaledStrokeWidth(part, scale))
        .join(" ");
}

function scaledStrokeWidth(value: string | null, scale: number): string | null {
  return value === null ? null : String(roundCanonical(Number(value) * scale));
}

function writeAttribute(
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

function writeRaw(
  node: SVGElement,
  attribute: string,
  value: string | null,
  instrumentation: MutableSceneInstrumentation,
  geometry: boolean,
): void {
  if (value === null) node.removeAttribute(attribute);
  else node.setAttribute(attribute, value);
  instrumentation.attributeWrites += 1;
  instrumentation.contentAttributeWrites += 1;
  if (geometry) instrumentation.contentGeometryWrites += 1;
}
