import { normalizeStrokePaint } from "../../../domain/geometry/pressure/pressure-paint";
import { buildElementPathParts } from "../../../domain/geometry/element-path";
import type { InkElementV1 } from "../../../domain/schema/public";
import { PRESENTATION_ATTRIBUTES, pathPresentation } from "../content/element-presentation";
import { SVG_NAMESPACE } from "../constants";
import { positionedTransform } from "../content/stroke-position";
import type { SvgPathPart } from "../../../domain/geometry/svg-path-part";
import { setTextMotionOrigin } from "../content/mounted-text";

export interface MotionVisual {
  readonly bytes: number;
  readonly targets: readonly MotionVisualTarget[];
  readonly nodes: readonly SVGElement[];
}

interface MotionGeometryReader {
  readonly path: (element: InkElementV1) => readonly SvgPathPart[] | undefined;
  readonly text: (
    element: InkElementV1,
    maximumNodes: number,
    maximumBytes: number,
  ) =>
    | { readonly root: SVGGElement; readonly nodes: readonly SVGElement[]; readonly bytes: number }
    | undefined;
}
type GeometryReader =
  ((element: InkElementV1) => readonly SvgPathPart[] | undefined) | MotionGeometryReader;

interface MotionVisualTarget {
  readonly node: SVGElement;
  opacity: number;
  renderedOpacity: number;
  readonly position?: string;
}

export function createMotionVisual(
  ownerDocument: Document,
  parent: SVGGElement,
  elements: readonly InkElementV1[],
  remainingPaths: number,
  remainingBytes: number,
  reader?: GeometryReader,
): MotionVisual {
  const nodes: SVGElement[] = [];
  const targets: MotionVisualTarget[] = [];
  let bytes = 0;
  for (const element of elements) {
    if (motionBudgetExhausted(nodes.length, bytes, remainingPaths, remainingBytes)) {
      return { bytes, nodes, targets };
    }
    if (element.kind === "text") {
      bytes += appendTextVisual(parent, element, {
        reader,
        remainingPaths: remainingPaths - nodes.length,
        remainingBytes: remainingBytes - bytes,
        nodes,
        targets,
      });
      continue;
    }
    const readCanonicalPath = typeof reader === "function" ? reader : reader?.path;
    const canonical = readCanonicalPath?.(element);
    const parts = canonical ?? buildElementPathParts(element);
    const grouped = element.kind === "stroke" && element.style.pressureEnabled;
    const groupBytes = parts.reduce((total, part) => total + part.d.length * 2, 0);
    if (nodes.length + parts.length > remainingPaths || bytes + groupBytes > remainingBytes) {
      return { bytes, nodes, targets };
    }
    const group = grouped ? ownerDocument.createElementNS(SVG_NAMESPACE, "g") : null;
    if (group !== null && element.kind === "stroke") {
      const opacity = normalizeStrokePaint(element.style).opacity;
      group.setAttribute("opacity", String(opacity));
      parent.append(group);
      targets.push({ node: group, opacity, renderedOpacity: opacity });
    }
    for (const part of parts) {
      const pathBytes = part.d.length * 2;
      const node = appendMotionPath(
        ownerDocument,
        group ?? parent,
        element,
        part,
        canonical !== undefined,
      );
      if (group === null)
        targets.push({
          node,
          opacity: 1,
          renderedOpacity: 1,
          position: canonical === undefined ? "" : strokeCssPosition(element),
        });
      nodes.push(node);
      bytes += pathBytes;
    }
  }
  return { bytes, nodes, targets };
}

function appendTextVisual(
  parent: SVGGElement,
  element: InkElementV1,
  context: {
    readonly reader: GeometryReader | undefined;
    readonly remainingPaths: number;
    readonly remainingBytes: number;
    readonly nodes: SVGElement[];
    readonly targets: MotionVisualTarget[];
  },
): number {
  if (typeof context.reader !== "object") return 0;
  const snapshot = context.reader.text(element, context.remainingPaths, context.remainingBytes);
  if (snapshot === undefined) return 0;
  parent.append(snapshot.root);
  context.nodes.push(...snapshot.nodes);
  const position = element.kind === "text" ? setTextMotionOrigin(snapshot.root, element) : "";
  context.targets.push({ node: snapshot.root, opacity: 1, renderedOpacity: 1, position });
  return snapshot.bytes;
}

function appendMotionPath(
  ownerDocument: Document,
  parent: SVGGElement,
  element: InkElementV1,
  part: ReturnType<typeof buildElementPathParts>[number],
  canonical: boolean,
): SVGPathElement {
  const node = ownerDocument.createElementNS(SVG_NAMESPACE, "path");
  node.setAttribute("d", part.d);
  const transform = canonical ? positionedTransform(element, null) : null;
  if (transform !== null) node.setAttribute("transform", transform);
  node.setAttribute("pointer-events", "none");
  node.setAttribute("aria-hidden", "true");
  const presentation = pathPresentation(element, part);
  for (const attribute of PRESENTATION_ATTRIBUTES) {
    const value = presentation[attribute];
    if (value !== null) node.setAttribute(attribute, value);
  }
  parent.append(node);
  return node;
}

function motionBudgetExhausted(
  paths: number,
  bytes: number,
  remainingPaths: number,
  remainingBytes: number,
): boolean {
  return paths >= remainingPaths || bytes >= remainingBytes;
}

function strokeCssPosition(element: InkElementV1): string {
  const offset = element.kind === "stroke" ? element.offset : undefined;
  return offset === undefined ? "" : `translate(${offset.x}px, ${offset.y}px) `;
}

export function removeMotionVisual(visual: MotionVisual): void {
  for (const target of visual.targets) target.node.remove();
}

export function writeMotionVisual(visual: MotionVisual, opacity: number, scale: number): void {
  for (const target of visual.targets) {
    target.renderedOpacity = Number(format(opacity * target.opacity));
    writeMotionStyle(target.node, target.renderedOpacity, scale, target.position);
  }
}

export function writeMotionStyle(
  node: SVGElement,
  opacity: number,
  scale: number,
  position = "",
): void {
  node.style.setProperty("opacity", format(opacity));
  node.style.setProperty("transform", `${position}scale(${format(scale)})`);
  node.setAttribute("data-inkbook-motion", "");
}

export function clearMotionStyle(node: SVGElement): void {
  node.style.removeProperty("opacity");
  node.style.removeProperty("transform");
  node.removeAttribute("data-inkbook-motion");
}

function format(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}
