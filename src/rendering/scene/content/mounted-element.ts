import { MountedTextPresentation, setTextMotionOrigin } from "./mounted-text";
import { MountedImagePresentation } from "./mounted-image";
import type { SceneImageResources } from "./image-resources";
import {
  createMountedPath,
  writeAttribute,
  writePresentation,
  writePreviewStrokeWidth,
  writeRaw,
  type MountedPath,
} from "./mounted-path";
import { positionedTransform } from "./stroke-position";
import { textBasisRebaseMatrix } from "../text-editing-geometry";
import { multiplyAffineMatrices, type AffineMatrix } from "../../../domain/geometry/affine-matrix";
import type { TextElementV2 } from "../../../domain/schema/public";
import type { SvgPathPart } from "../../../domain/geometry/element-path";
import { SVG_NAMESPACE } from "../constants";
import {
  isPressureStroke,
  pressureRootOpacity,
  pathPresentation,
  PRESENTATION_ATTRIBUTES,
} from "./element-presentation";
import type { MutableSceneInstrumentation, SceneElementRecord } from "../types";
import {
  setMountedElementFade,
  setElementFadeNode,
  type ElementFadePresentation,
} from "../presentation/element-fade-style";
import {
  clearMotionStyle,
  writeMotionStyle,
  setPathMotionOrigin,
} from "../presentation/motion-visual";
import {
  writeAutoPaintBounds,
  elementAutoPaintBounds,
  previewAutoPaintBounds,
} from "./auto-paint-bounds";
import { releaseLivePaintHold } from "./live-paint-handoff";

export { setMountedElementFade } from "../presentation/element-fade-style";

interface TopologyUpdateOptions {
  readonly instrumentation: MutableSceneInstrumentation;
  readonly ownerDocument: Document;
  readonly parent: SVGGElement;
}

export interface MountedSceneElement {
  textScaleFeedback?: { readonly basis: TextElementV2; readonly matrix: AffineMatrix } | undefined;
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
  appliedPreviewMatrix?: readonly [number, number, number, number, number, number] | undefined;
  appliedTransform: string | null;
  geometryVersion: number;
  readonly id: string;
  paintVersion: number;
  readonly paths: MountedPath[];
  text?: MountedTextPresentation | undefined;
  image?: MountedImagePresentation | undefined;
  pathParts: readonly SvgPathPart[];
  previewStrokeWidthScale: number | null;
  previewTransformVersion: number;
  rank: number;
}

export function retainTextScaleFeedback(
  entry: MountedSceneElement,
  basis?: TextElementV2,
  matrix?: AffineMatrix,
): void {
  if (entry.text === undefined) return;
  entry.textScaleFeedback =
    basis === undefined || matrix === undefined ? undefined : { basis, matrix };
}

export function createMountedElement(
  ownerDocument: Document,
  record: SceneElementRecord,
  parts: readonly SvgPathPart[],
  instrumentation: MutableSceneInstrumentation,
  preparedText?: MountedTextPresentation,
  imageResources?: SceneImageResources,
): MountedSceneElement {
  const paths = parts.map((part) =>
    createMountedPath(ownerDocument, record, part, instrumentation),
  );
  const text =
    preparedText ??
    (record.element.kind === "text"
      ? new MountedTextPresentation(ownerDocument, record.element, instrumentation)
      : undefined);
  const image =
    record.element.kind === "image" && imageResources !== undefined
      ? new MountedImagePresentation(ownerDocument, record.element, imageResources, instrumentation)
      : undefined;
  const group =
    image?.group ??
    text?.group ??
    createPressureGroup(ownerDocument, record, paths, instrumentation);
  if (text !== undefined)
    writeAutoPaintBounds(text.group, elementAutoPaintBounds(record.element, record.bounds));
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
    groupOpacity: pressureRootOpacity(record.element),
    appliedPreviewTransform: null,
    appliedTransform: null,
    geometryVersion: record.geometryVersion,
    id: record.id,
    paintVersion: record.paintVersion,
    paths,
    text,
    image,
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
  entry.image?.release();
  entry.text?.cancelPreparation();
  if (entry.fadeActive) setMountedElementFade(entry, null);
  if (entry.group !== null) {
    releaseLivePaintHold(entry.group);
    entry.group.remove();
  } else
    for (const path of entry.paths) {
      releaseLivePaintHold(path.node);
      path.node.remove();
    }
}

/** Removes one top-level SVG node, retaining partial path ownership until reconciliation ends. */
export function removeMountedElementNode(entry: MountedSceneElement): boolean {
  if (entry.group !== null) {
    releaseLivePaintHold(entry.group);
    entry.image?.release();
    entry.text?.cancelPreparation();
    if (entry.fadeActive) setMountedElementFade(entry, null);
    entry.group.remove();
    return true;
  }
  const index = entry.paths.length - entry.detachedPathCount - 1;
  const node = entry.paths[index]?.node;
  if (node !== undefined) releaseLivePaintHold(node);
  if (node !== undefined && entry.fadeActive)
    setElementFadeNode(node, null, entry.fadePresentation ?? "opacity");
  node?.remove();
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
  updateMountedPreviewGeometry(entry, record, parts, { instrumentation, ownerDocument, parent });
  entry.pathParts = parts;
  entry.bounds = record.bounds;
  entry.displayedElement = record.element;
  const autoBounds = elementAutoPaintBounds(record.element, record.bounds);
  for (const node of [
    ...entry.paths.map((path) => path.node),
    ...(entry.group === null ? [] : [entry.group]),
  ]) {
    writeAutoPaintBounds(node, autoBounds);
  }
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
  if (entry.text !== undefined && record.element.kind === "text") entry.text.update(record.element);
  if (entry.image !== undefined && record.element.kind === "image")
    entry.image.update(record.element);
  const opacity = pressureRootOpacity(record.element);
  const pressure = isPressureStroke(record.element);
  const previousPressure = isPressureStroke(entry.displayedElement);
  if (pressure !== previousPressure) {
    setMountedElementFade(entry, null);
    setMountedElementMotion(entry, null);
  }
  if (entry.groupOpacity !== opacity || pressure !== previousPressure) {
    const node = firstPath(entry);
    writeRaw(node, "opacity", pressure ? String(opacity) : null, instrumentation, false);
  }
  entry.groupOpacity = opacity;
  let autoBounds: SceneElementRecord["bounds"] | undefined;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const path = entry.paths[index];
    if (part === undefined || path === undefined) continue;
    const presentation = pathPresentation(record.element, part);
    if (presentation.class !== null) {
      autoBounds ??= elementAutoPaintBounds(record.element, record.bounds);
      writeAutoPaintBounds(path.node, autoBounds);
    }
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
  matrix?: MountedSceneElement["appliedPreviewMatrix"],
): void {
  const textFeedback = entry.text === undefined ? undefined : entry.textScaleFeedback;
  if (transform !== null && textFeedback !== undefined && entry.displayedElement.kind === "text") {
    matrix =
      entry.displayedElement === textFeedback.basis
        ? textFeedback.matrix
        : multiplyAffineMatrices(
            textFeedback.matrix,
            textBasisRebaseMatrix(entry.displayedElement, textFeedback.basis),
          );
    transform = `matrix(${matrix.join(" ")})`;
  }
  entry.appliedPreviewTransform = transform;
  entry.appliedPreviewMatrix = matrix?.every(Number.isFinite) ? matrix : undefined;
  if (entry.text !== undefined) entry.text.previewMatrix = entry.appliedPreviewMatrix;
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
    readonly paintBounds?: SceneElementRecord["bounds"] | undefined;
  },
): void {
  const { geometryVersion, paintVersion, pathParts, rank } = entry;
  updateMountedPreviewGeometry(entry, { ...record, element: previewElement }, parts, options);
  entry.displayedElement = previewElement;
  const autoBounds = previewAutoPaintBounds(
    previewElement,
    record.element,
    record.bounds,
    options.paintBounds,
  );
  for (const node of [
    ...entry.paths.map((path) => path.node),
    ...(entry.group === null ? [] : [entry.group]),
  ])
    writeAutoPaintBounds(node, autoBounds);
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
  if (entry.image !== undefined && record.element.kind === "image") {
    entry.image.update(record.element);
    return;
  } else if (entry.text !== undefined && record.element.kind === "text") {
    entry.text.update(record.element);
    return;
  } else if (
    entry.paths.length !== parts.length ||
    (entry.group !== null) !== (isPressureStroke(record.element) && parts.length > 1)
  ) {
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

export function setMountedElementMotion(
  entry: MountedSceneElement,
  opacity: number | null,
  scale = 1,
): void {
  if (opacity === null && !entry.motionActive) return;
  entry.motionActive = opacity !== null;
  if (entry.text) entry.text.motionScale = opacity === null ? 1 : scale;
  const nodes = entry.group === null ? entry.paths.map((path) => path.node) : [entry.group];
  for (const node of nodes) {
    const element = entry.displayedElement;
    if (element.kind !== "text" && element.kind !== "image")
      setPathMotionOrigin(node, elementAutoPaintBounds(element, entry.bounds));
    const textPosition =
      entry.displayedElement.kind === "text" || entry.displayedElement.kind === "image"
        ? setTextMotionOrigin(node, opacity === null ? null : entry.displayedElement)
        : element.kind === "stroke" && element.offset !== undefined
          ? `translate(${element.offset.x}px, ${element.offset.y}px) `
          : "";
    if (opacity === null) clearMotionStyle(node);
    else writeMotionStyle(node, opacity * entry.groupOpacity, scale, textPosition);
  }
}

export function firstPath(entry: MountedSceneElement): SVGElement {
  if (entry.group !== null) return entry.group;
  const path = entry.paths[0];
  if (path === undefined) throw new Error("A mounted element must own at least one path.");
  return path.node;
}

function replacePathTopology(
  entry: MountedSceneElement,
  record: SceneElementRecord,
  parts: readonly SvgPathPart[],
  options: TopologyUpdateOptions,
): void {
  const transform = entry.appliedPreviewTransform;
  const matrix = entry.appliedPreviewMatrix;
  const strokeWidthScale = entry.previewStrokeWidthScale;
  const reference = firstPath(entry);
  const fragment = createFragment(options.ownerDocument);
  const paths = parts.map((part) =>
    createMountedPath(options.ownerDocument, record, part, options.instrumentation),
  );
  const group = createPressureGroup(options.ownerDocument, record, paths, options.instrumentation);
  if (group === null) for (const path of paths) fragment.append(path.node);
  else fragment.append(group);
  const parent = reference.parentNode ?? options.parent;
  parent.insertBefore(fragment, reference);
  removeMountedElement(entry);
  entry.detachedPathCount = 0;
  entry.group = group;
  entry.motionActive = false;
  entry.groupOpacity = pressureRootOpacity(record.element);
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
    matrix,
  );
}

function createPressureGroup(
  ownerDocument: Document,
  record: SceneElementRecord,
  paths: readonly MountedPath[],
  instrumentation: MutableSceneInstrumentation,
): SVGGElement | null {
  if (!isPressureStroke(record.element)) return null;
  const group = paths.length === 1 ? null : ownerDocument.createElementNS(SVG_NAMESPACE, "g");
  writeRaw(
    group ?? paths[0]!.node,
    "opacity",
    String(pressureRootOpacity(record.element)),
    instrumentation,
    false,
  );
  if (group !== null) for (const path of paths) group.append(path.node);
  return group;
}

export function createFragment(ownerDocument: Document): DocumentFragment {
  const create = ownerDocument.createDocumentFragment.bind(ownerDocument);
  return create();
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
    entry.appliedPreviewMatrix,
  );
}
