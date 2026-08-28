import type { PageV1 } from "../../domain/schema/public";
import { patternCoveragePath, type SceneBackgroundCache } from "./background-cache";
import { SVG_NAMESPACE } from "./constants";
import {
  PRESENTATION_ATTRIBUTES,
  type PathPresentation,
  type PresentationAttribute,
} from "./element-presentation";
import type { SceneDom } from "./scene-dom";
import type {
  DocumentScheme,
  LivePathState,
  MutableSceneInstrumentation,
  SceneCamera,
} from "./types";

interface AppliedLivePathPart {
  readonly d: string;
  readonly node: SVGPathElement;
  readonly presentation: PathPresentation;
}

export interface AppliedLivePath {
  readonly band: "content" | "highlight";
  readonly parts: readonly AppliedLivePathPart[];
}

const EMPTY_PRESENTATION = Object.freeze(
  Object.fromEntries(PRESENTATION_ATTRIBUTES.map((attribute) => [attribute, null])),
) as PathPresentation;

export function emptyAppliedLivePath(): AppliedLivePath {
  return { band: "content", parts: [] };
}

export function writeLivePath(
  dom: SceneDom,
  instrumentation: MutableSceneInstrumentation,
  path: LivePathState,
  applied: AppliedLivePath,
): AppliedLivePath {
  const band = path.band ?? "content";
  dom.placeLiveGroup("path", band);
  const next: AppliedLivePathPart[] = [];
  for (let index = 0; index < path.parts.length; index += 1) {
    const part = path.parts[index]!;
    const previous = applied.parts[index];
    const node = previous?.node ?? createLivePathNode(dom, index);
    writeLiveGeometry(node, part.d, previous?.d ?? "", instrumentation);
    writeLivePresentation(
      node,
      part.presentation,
      previous?.presentation ?? EMPTY_PRESENTATION,
      instrumentation,
    );
    next.push({ d: part.d, node, presentation: part.presentation });
  }
  for (const removed of applied.parts.slice(path.parts.length)) removed.node.remove();
  if (path.parts.length === 0) clearPrimaryLivePath(dom, applied.parts[0], instrumentation);
  return { band, parts: next };
}

function createLivePathNode(dom: SceneDom, index: number): SVGPathElement {
  const node =
    index === 0 ? dom.livePath : dom.ownerDocument.createElementNS(SVG_NAMESPACE, "path");
  node.setAttribute("pointer-events", "none");
  dom.liveGroup.append(node);
  return node;
}

function clearPrimaryLivePath(
  dom: SceneDom,
  previous: AppliedLivePathPart | undefined,
  instrumentation: MutableSceneInstrumentation,
): void {
  dom.liveGroup.append(dom.livePath);
  writeLiveGeometry(dom.livePath, "", previous?.d ?? "", instrumentation);
  writeLivePresentation(
    dom.livePath,
    EMPTY_PRESENTATION,
    previous?.presentation ?? EMPTY_PRESENTATION,
    instrumentation,
  );
}

function writeLiveGeometry(
  node: SVGPathElement,
  d: string,
  applied: string,
  instrumentation: MutableSceneInstrumentation,
): void {
  if (d === applied) return;
  node.setAttribute("d", d);
  instrumentation.attributeWrites += 1;
}

function writeLivePresentation(
  node: SVGPathElement,
  presentation: PathPresentation,
  applied: PathPresentation,
  instrumentation: MutableSceneInstrumentation,
): void {
  for (const attribute of PRESENTATION_ATTRIBUTES) {
    const value = presentation[attribute];
    if (value === applied[attribute]) continue;
    writeLiveAttribute(node, attribute, value);
    instrumentation.attributeWrites += 1;
  }
}

function writeLiveAttribute(
  node: SVGPathElement,
  attribute: PresentationAttribute,
  value: string | null,
): void {
  if (value === null) node.removeAttribute(attribute);
  else node.setAttribute(attribute, value);
}

export function writeCamera(
  dom: SceneDom,
  instrumentation: MutableSceneInstrumentation,
  camera: SceneCamera,
  applied: string,
): string {
  const transform = `translate(${camera.x * camera.zoom} 0) scale(${camera.zoom})`;
  if (transform === applied) return applied;
  dom.cameraGroup.setAttribute("transform", transform);
  instrumentation.attributeWrites += 1;
  return transform;
}

export function writeOverlay(
  dom: SceneDom,
  instrumentation: MutableSceneInstrumentation,
  path: string,
  applied: string,
): string {
  if (path === applied) return applied;
  dom.overlayPath.setAttribute("d", path);
  instrumentation.attributeWrites += 1;
  return path;
}

export function writeScheme(
  dom: SceneDom,
  instrumentation: MutableSceneInstrumentation,
  scheme: DocumentScheme,
): void {
  dom.setScheme(scheme);
  instrumentation.themeWrites += 1;
}

interface BackgroundWriteOptions {
  readonly applied: {
    readonly d: string;
    readonly edgeD: string;
    readonly key: string | undefined;
    readonly pageHeight: number | undefined;
  };
  readonly cache: SceneBackgroundCache;
  readonly dom: SceneDom;
  readonly instrumentation: MutableSceneInstrumentation;
  readonly page: PageV1;
  readonly pageHeight: number;
  readonly zoom: number;
}

export function writeBackground(options: BackgroundWriteOptions): {
  readonly d: string;
  readonly edgeD: string;
  readonly key: string;
  readonly pageHeight: number;
} {
  const { applied, cache, dom, instrumentation, page, pageHeight, zoom } = options;
  const result = cache.resolve({
    background: page.background,
    innerWidth: page.innerWidth,
    margin: page.margin,
    pageHeight,
  });
  const d =
    result.patternBounds !== null
      ? patternCoveragePath(result.patternBounds, patternCoverageInset(page, zoom))
      : result.d;
  if (d !== applied.d) {
    dom.backgroundPath.setAttribute("d", d);
    instrumentation.attributeWrites += 1;
  }
  if (result.edgeD !== applied.edgeD) {
    dom.backgroundEdgePath.setAttribute("d", result.edgeD);
    instrumentation.attributeWrites += 1;
  }
  if (pageHeight !== applied.pageHeight) {
    dom.setPageHeight(pageHeight);
    instrumentation.attributeWrites += 1;
  }
  const key = backgroundPaintKey(page, result.paint, result.patternX, result.patternY, zoom);
  if (key !== applied.key) {
    dom.setBackgroundPaint(page.background, result.paint, result.patternX, result.patternY, zoom);
    instrumentation.attributeWrites += 2;
  }
  return { d, edgeD: result.edgeD, key, pageHeight };
}

function patternCoverageInset(page: PageV1, zoom: number): number {
  if (page.background.type === "none") return 0;
  const strokeWidth = page.background.type === "dots" ? 2 : 1;
  return strokeWidth / (2 * zoom);
}

function backgroundPaintKey(
  page: PageV1,
  paint: "none" | "pattern",
  patternX: number,
  patternY: number,
  zoom: number,
): string {
  return page.background.type === "none"
    ? "none"
    : `${page.background.type}:${paint}:${String(page.background.spacing)}:${String(patternX)}:${String(patternY)}:${String(zoom)}`;
}
