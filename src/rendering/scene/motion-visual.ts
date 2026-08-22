import { buildElementPathParts } from "../../domain/geometry/element-path";
import type { InkElementV1 } from "../../domain/schema/public";
import { PRESENTATION_ATTRIBUTES, pathPresentation } from "./element-presentation";
import { SVG_NAMESPACE } from "./constants";

export interface MotionVisual {
  readonly bytes: number;
  readonly nodes: readonly SVGPathElement[];
}

export function createMotionVisual(
  ownerDocument: Document,
  parent: SVGGElement,
  elements: readonly InkElementV1[],
  remainingPaths: number,
  remainingBytes: number,
): MotionVisual {
  const nodes: SVGPathElement[] = [];
  let bytes = 0;
  for (const element of elements) {
    for (const part of buildElementPathParts(element)) {
      const pathBytes = part.d.length * 2;
      if (nodes.length >= remainingPaths || bytes + pathBytes > remainingBytes) {
        return { bytes, nodes };
      }
      const node = ownerDocument.createElementNS(SVG_NAMESPACE, "path");
      node.setAttribute("d", part.d);
      node.setAttribute("pointer-events", "none");
      node.setAttribute("aria-hidden", "true");
      const presentation = pathPresentation(element, part);
      for (const attribute of PRESENTATION_ATTRIBUTES) {
        const value = presentation[attribute];
        if (value !== null) node.setAttribute(attribute, value);
      }
      parent.append(node);
      nodes.push(node);
      bytes += pathBytes;
    }
  }
  return { bytes, nodes };
}

export function removeMotionVisual(visual: MotionVisual): void {
  for (const node of visual.nodes) node.remove();
}

export function writeMotionVisual(visual: MotionVisual, opacity: number, scale: number): void {
  for (const node of visual.nodes) writeMotionStyle(node, opacity, scale);
}

export function writeMotionStyle(node: SVGPathElement, opacity: number, scale: number): void {
  node.style.setProperty("opacity", format(opacity));
  node.style.setProperty("transform", `scale(${format(scale)})`);
  node.setAttribute("data-inkbook-motion", "");
}

export function clearMotionStyle(node: SVGPathElement): void {
  node.style.removeProperty("opacity");
  node.style.removeProperty("transform");
  node.removeAttribute("data-inkbook-motion");
}

function format(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}
