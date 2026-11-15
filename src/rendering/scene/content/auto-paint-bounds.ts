import type { Bounds } from "../../../domain/geometry/primitives";
import type { InkElementV1 } from "../../../domain/schema/types";
import { autoPaintLocalBounds } from "../auto-paint-transform";
import type { AffineMatrix } from "../../../domain/geometry/affine-matrix";
import { calculateElementBounds, effectiveStrokeWidth } from "../../../domain/geometry/bounds";
import { expandBounds } from "../../../domain/geometry/primitives";

interface AutoPaintNode extends SVGElement {
  inkbookAutoPaintBounds?: { bounds: Bounds | undefined; changed?: (() => void) | undefined };
}

/** Reuses prepared record geometry; no DOM measurement or contour rebuild. */
export function elementAutoPaintBounds(element: InkElementV1, bounds: Bounds): Bounds {
  if (element.kind === "stroke") {
    const x = element.offset?.x ?? 0;
    const y = element.offset?.y ?? 0;
    if (x === 0 && y === 0) return bounds;
    return {
      minX: bounds.minX - x,
      minY: bounds.minY - y,
      maxX: bounds.maxX - x,
      maxY: bounds.maxY - y,
    };
  }
  if (element.kind !== "text" && element.kind !== "image") return bounds;
  const angle = (element.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const { x, y } = element.pivot;
  const matrix: AffineMatrix = [cos, sin, -sin, cos, x - cos * x + sin * y, y - sin * x - cos * y];
  return autoPaintLocalBounds(bounds, matrix) ?? bounds;
}

export function writeAutoPaintBounds(node: SVGElement, bounds: Bounds | undefined): void {
  const target = node as AutoPaintNode;
  const previous = target.inkbookAutoPaintBounds;
  if (previous === undefined) target.inkbookAutoPaintBounds = { bounds };
  else {
    if (previous.bounds === bounds) return;
    previous.bounds = bounds;
    previous.changed?.();
  }
}

export function readAutoPaintBounds(node: SVGElement): Bounds | undefined {
  return (node as AutoPaintNode).inkbookAutoPaintBounds?.bounds;
}

export function hasAutoPaintBounds(node: SVGElement): boolean {
  return (node as AutoPaintNode).inkbookAutoPaintBounds !== undefined;
}

export function previewAutoPaintBounds(
  preview: InkElementV1,
  source: InkElementV1,
  bounds: Bounds,
  prepared?: Bounds,
): Bounds {
  if (prepared !== undefined) return elementAutoPaintBounds(preview, prepared);
  if (
    preview.kind !== "stroke" ||
    source.kind !== "stroke" ||
    preview.points !== source.points ||
    preview.rotation !== source.rotation
  )
    return elementAutoPaintBounds(preview, calculateElementBounds(preview));
  const reserve = Math.max(0, effectiveStrokeWidth(preview) - effectiveStrokeWidth(source));
  return expandBounds(elementAutoPaintBounds(source, bounds), reserve);
}

export function observeAutoPaintBounds(node: SVGElement, changed?: () => void): void {
  const value = (node as AutoPaintNode).inkbookAutoPaintBounds;
  if (value !== undefined) value.changed = changed;
}
