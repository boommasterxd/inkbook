import { normalizeStrokePaint } from "../../domain/geometry/pressure-paint";
import { buildElementPathParts } from "../../domain/geometry/element-path";
import type { InkElementV1 } from "../../domain/schema/public";
import { PRESENTATION_ATTRIBUTES, pathPresentation } from "./element-presentation";
import { SVG_NAMESPACE } from "./constants";

export interface MotionVisual {
  readonly bytes: number;
  readonly targets: readonly { node: SVGElement; opacity: number }[];
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
  const targets: { node: SVGElement; opacity: number }[] = [];
  let bytes = 0;
  for (const element of elements) {
    if (motionBudgetExhausted(nodes.length, bytes, remainingPaths, remainingBytes)) {
      return { bytes, nodes, targets };
    }
    const parts = buildElementPathParts(element);
    const grouped = element.kind === "stroke" && element.style.pressureEnabled;
    const groupBytes = parts.reduce((total, part) => total + part.d.length * 2, 0);
    if (
      grouped &&
      (nodes.length + parts.length > remainingPaths || bytes + groupBytes > remainingBytes)
    ) {
      return { bytes, nodes, targets };
    }
    const group = grouped ? ownerDocument.createElementNS(SVG_NAMESPACE, "g") : null;
    if (group !== null && element.kind === "stroke") {
      const opacity = normalizeStrokePaint(element.style).opacity;
      group.setAttribute("opacity", String(opacity));
      parent.append(group);
      targets.push({ node: group, opacity });
    }
    for (const part of parts) {
      const pathBytes = part.d.length * 2;
      if (nodes.length >= remainingPaths || bytes + pathBytes > remainingBytes) {
        return { bytes, nodes, targets };
      }
      const node = appendMotionPath(ownerDocument, group ?? parent, element, part);
      if (group === null) targets.push({ node, opacity: 1 });
      nodes.push(node);
      bytes += pathBytes;
    }
  }
  return { bytes, nodes, targets };
}

function appendMotionPath(
  ownerDocument: Document,
  parent: SVGGElement,
  element: InkElementV1,
  part: ReturnType<typeof buildElementPathParts>[number],
): SVGPathElement {
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

export function removeMotionVisual(visual: MotionVisual): void {
  for (const target of visual.targets) target.node.remove();
}

export function writeMotionVisual(visual: MotionVisual, opacity: number, scale: number): void {
  for (const target of visual.targets)
    writeMotionStyle(target.node, opacity * target.opacity, scale);
}

export function writeMotionStyle(node: SVGElement, opacity: number, scale: number): void {
  node.style.setProperty("opacity", format(opacity));
  node.style.setProperty("transform", `scale(${format(scale)})`);
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
