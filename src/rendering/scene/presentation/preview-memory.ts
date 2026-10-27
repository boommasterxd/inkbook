import type { SvgPathPart } from "../../../domain/geometry/element-path";
import type { InkElementV1 } from "../../../domain/schema/public";
import type { ProgressivePreviewTransform } from "./progressive-preview-request";
import type { PreviewTransform } from "../reconciliation/scene-mount-preparation";

export function elementBytes(element: InkElementV1): number {
  return 128 + (element.kind === "stroke" ? element.points.length * 8 : 0);
}

/** Replaces one owned preview and returns its retained-payload accounting delta. */
export function storePreviewElement(
  entries: Map<string, InkElementV1>,
  id: string,
  element: InkElementV1 | undefined,
): number {
  const previous = entries.get(id);
  const delta =
    (element === undefined ? 0 : elementBytes(element)) -
    (previous === undefined ? 0 : elementBytes(previous));
  if (element === undefined) entries.delete(id);
  else entries.set(id, element);
  return delta;
}

export function pathBytes(parts: readonly SvgPathPart[]): number {
  return parts.reduce((bytes, part) => bytes + part.d.length * 2, 0);
}

export function feedbackBytes(
  id: string,
  feedback: { transform: string; inverse: string },
): number {
  return 64 + (id.length + feedback.transform.length + feedback.inverse.length) * 2;
}

export function storePreviewFeedback(
  entries: Map<string, ProgressivePreviewTransform>,
  id: string,
  feedback: ProgressivePreviewTransform | undefined,
): number {
  const previous = entries.get(id);
  const delta =
    (feedback === undefined ? 0 : feedbackBytes(id, feedback)) -
    (previous === undefined ? 0 : feedbackBytes(id, previous));
  if (feedback === undefined) entries.delete(id);
  else entries.set(id, feedback);
  return delta;
}

export function storePreviewTransform(
  entries: Map<string, PreviewTransform>,
  id: string,
  preview: PreviewTransform | undefined,
): number {
  const previous = entries.get(id);
  const delta =
    (preview === undefined ? 0 : transformBytes(id, preview)) -
    (previous === undefined ? 0 : transformBytes(id, previous));
  if (preview === undefined) entries.delete(id);
  else entries.set(id, preview);
  return delta;
}

export function transformBytes(id: string, preview: { transform: string | null }): number {
  return 80 + (id.length + (preview.transform?.length ?? 0)) * 2;
}
