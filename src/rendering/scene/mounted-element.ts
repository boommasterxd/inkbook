import { positionedTransform } from "./stroke-position";
import { normalizeStrokePaint } from "../../domain/geometry/pressure-paint";
import type { SvgPathPart } from "../../domain/geometry/element-path";
import { SVG_NAMESPACE } from "./constants";
import {
  scaledDashPattern,
  scaledStrokeWidth,
  PRESENTATION_ATTRIBUTES,
  pathPresentation,
  type PathPresentation,
  type PresentationAttribute,
} from "./element-presentation";
import type { MutableSceneInstrumentation, SceneElementRecord } from "./types";
import {
  elementFadePresentation,
  elementFadeTarget,
  elementFadeTargetCount,
  setElementFadeNode,
  type ElementFadePresentation,
} from "./element-fade-style";
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
  bounds: SceneElementRecord["bounds"];
  /** Rank at the last published DOM ordering, independent of paint/geometry updates. */
  committedRank: number;
  committedOrderEpoch: number;
  detachedPathCount: number;
  fadeActive: boolean;
  fadePresentation: ElementFadePresentation | null;
  motionActive: boolean;
  displayedElement: SceneElementRecord["element"];
  displayedPathParts: readonly SvgPathPart[];
  group: SVGGElement | null;
  groupOpacity: number;
  appliedPreviewTransform: string | null;
  appliedTransform: string | null;
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
  const group = createPressureGroup(ownerDocument, record, paths, instrumentation);
  const entry: MountedSceneElement = {
    band: record.band,
    bounds: record.bounds,
    committedRank: record.rank,
    committedOrderEpoch: 0,
    detachedPathCount: 0,
    fadeActive: false,
    fadePresentation: null,
    motionActive: false,
    displayedElement: record.element,
    displayedPathParts: parts,
    group,
    groupOpacity: pressureGroupOpacity(record),
    appliedPreviewTransform: null,
    appliedTransform: null,
    geometryVersion: record.geometryVersion,
    id: record.id,
    paintVersion: record.paintVersion,
    paths,
    pathParts: parts,
    previewStrokeWidthScale: null,
    previewTransformVersion: 0,
    rank: record.rank,
  };
  updatePreviewTransform(entry, null, 0, null, instrumentation);
  return entry;
}

export function appendElementToFragment(
  entry: MountedSceneElement,
  fragment: DocumentFragment,
): void {
  if (entry.group !== null) fragment.append(entry.group);
  else for (const path of entry.paths) fragment.append(path.node);
  entry.detachedPathCount = 0;
}

export function removeMountedElement(entry: MountedSceneElement): void {
  if (entry.group !== null) entry.group.remove();
  else for (const path of entry.paths) path.node.remove();
}

/** Removes one top-level SVG node, retaining partial path ownership until reconciliation ends. */
export function removeMountedElementNode(entry: MountedSceneElement): boolean {
  if (entry.group !== null) {
    entry.group.remove();
    return true;
  }
  const index = entry.paths.length - entry.detachedPathCount - 1;
  entry.paths[index]?.node.remove();
  entry.detachedPathCount += 1;
  return entry.detachedPathCount >= entry.paths.length;
}

export function updateMountedGeometry(
  entry: MountedSceneElement,
  record: SceneElementRecord,
  parts: readonly SvgPathPart[],
  ownerDocument: Document,
  parent: SVGGElement,
  instrumentation: MutableSceneInstrumentation,
): void {
  if (entry.paths.length !== parts.length || (entry.group !== null) !== isPressureStroke(record)) {
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
  entry.bounds = record.bounds;
  entry.displayedElement = record.element;
  refreshPosition(entry, instrumentation);
  entry.displayedPathParts = parts;
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
  const opacity = pressureGroupOpacity(record);
  if (entry.group !== null && entry.groupOpacity !== opacity) {
    writeRaw(entry.group, "opacity", String(opacity), instrumentation, false);
    entry.groupOpacity = opacity;
  }
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
  entry.appliedPreviewTransform = transform;
  transform = positionedTransform(entry.displayedElement, transform);
  if (entry.group !== null) {
    if (entry.appliedTransform !== transform) {
      writeRaw(entry.group, "transform", transform, instrumentation, true);
      entry.appliedTransform = transform;
    }
    if (entry.previewStrokeWidthScale !== strokeWidthScale) {
      for (const path of entry.paths)
        writePreviewStrokeWidth(path, strokeWidthScale, instrumentation);
    }
    entry.previewStrokeWidthScale = strokeWidthScale;
    entry.previewTransformVersion = version;
    return;
  }
  entry.appliedTransform = transform;
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
  const { geometryVersion, paintVersion, pathParts, rank } = entry;
  updateMountedPreviewGeometry(entry, { ...record, element: previewElement }, parts, options);
  entry.displayedElement = previewElement;
  refreshPosition(entry, options.instrumentation);
  entry.displayedPathParts = parts;
  entry.geometryVersion = geometryVersion;
  entry.paintVersion = paintVersion;
  entry.pathParts = pathParts;
  entry.rank = rank;
}

function updateMountedPreviewGeometry(
  entry: MountedSceneElement,
  record: SceneElementRecord,
  parts: readonly SvgPathPart[],
  options: TopologyUpdateOptions,
): void {
  if (entry.paths.length !== parts.length || (entry.group !== null) !== isPressureStroke(record)) {
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
  const presentation = elementFadePresentation(entry);
  const previousPresentation = entry.fadePresentation ?? presentation;
  if (durationMs !== null && entry.fadeActive && previousPresentation !== presentation)
    setMountedElementFade(entry, null);
  const targetPresentation = durationMs === null ? previousPresentation : presentation;
  entry.fadeActive = durationMs !== null;
  entry.fadePresentation = durationMs === null ? null : presentation;
  for (let index = 0; index < elementFadeTargetCount(entry, targetPresentation); index += 1) {
    const node = elementFadeTarget(entry, index, targetPresentation);
    if (node !== undefined) setElementFadeNode(node, durationMs, targetPresentation);
  }
}

export function setMountedElementMotion(
  entry: MountedSceneElement,
  opacity: number | null,
  scale = 1,
): void {
  if (opacity === null && !entry.motionActive) return;
  entry.motionActive = opacity !== null;
  const nodes = entry.group === null ? entry.paths.map((path) => path.node) : [entry.group];
  for (const node of nodes)
    if (opacity === null) clearMotionStyle(node);
    else writeMotionStyle(node, opacity * entry.groupOpacity, scale);
}

export function firstPath(entry: MountedSceneElement): SVGElement {
  if (entry.group !== null) return entry.group;
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
  const transform = entry.appliedPreviewTransform;
  const strokeWidthScale = entry.previewStrokeWidthScale;
  const reference = firstPath(entry);
  const fragment = createFragment(options.ownerDocument);
  const paths = parts.map((part) =>
    createMountedPath(options.ownerDocument, record, part, options.instrumentation),
  );
  const group = createPressureGroup(options.ownerDocument, record, paths, options.instrumentation);
  if (group === null) for (const path of paths) fragment.append(path.node);
  else fragment.append(group);
  options.parent.insertBefore(fragment, reference);
  removeMountedElement(entry);
  entry.detachedPathCount = 0;
  entry.group = group;
  entry.motionActive = false;
  entry.groupOpacity = pressureGroupOpacity(record);
  entry.appliedPreviewTransform = null;
  entry.appliedTransform = null;
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

function isPressureStroke(record: SceneElementRecord): boolean {
  return record.element.kind === "stroke" && record.element.style.pressureEnabled;
}

function pressureGroupOpacity(record: SceneElementRecord): number {
  return isPressureStroke(record) && record.element.kind === "stroke"
    ? normalizeStrokePaint(record.element.style).opacity
    : 1;
}

function createPressureGroup(
  ownerDocument: Document,
  record: SceneElementRecord,
  paths: readonly MountedPath[],
  instrumentation: MutableSceneInstrumentation,
): SVGGElement | null {
  if (!isPressureStroke(record)) return null;
  const group = ownerDocument.createElementNS(SVG_NAMESPACE, "g");
  writeRaw(group, "opacity", String(pressureGroupOpacity(record)), instrumentation, false);
  for (const path of paths) group.append(path.node);
  return group;
}

export function createFragment(ownerDocument: Document): DocumentFragment {
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

function refreshPosition(
  entry: MountedSceneElement,
  instrumentation: MutableSceneInstrumentation,
): void {
  updatePreviewTransform(
    entry,
    entry.appliedPreviewTransform,
    entry.previewTransformVersion,
    entry.previewStrokeWidthScale,
    instrumentation,
  );
}
