import type { MutableSceneInstrumentation } from "../types";

interface ImagePaintNode extends SVGElement {
  inkbookImageInstrumentation?: MutableSceneInstrumentation;
}

export function bindImagePaintInstrumentation(
  node: SVGElement,
  instrumentation: MutableSceneInstrumentation,
): void {
  (node as ImagePaintNode).inkbookImageInstrumentation = instrumentation;
}

export function writeImageOpacity(node: SVGElement, value: string): void {
  if (node.style.getPropertyValue("opacity") === value) return;
  node.style.setProperty("opacity", value);
  record(node);
}

export function clearImageOpacity(node: SVGElement): void {
  if (!node.style.getPropertyValue("opacity")) return;
  node.style.removeProperty("opacity");
  record(node);
}

function record(node: SVGElement): void {
  const value = (node as ImagePaintNode).inkbookImageInstrumentation;
  if (value === undefined) return;
  value.attributeWrites += 1;
  value.contentAttributeWrites += 1;
}
