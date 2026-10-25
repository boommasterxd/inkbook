import type { SvgPathPart } from "../../../domain/geometry/element-path";
import type { InkElementV1 } from "../../../domain/schema/public";

export function elementBytes(element: InkElementV1): number {
  return 128 + (element.kind === "stroke" ? element.points.length * 8 : 0);
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

export function transformBytes(id: string, preview: { transform: string | null }): number {
  return 80 + (id.length + (preview.transform?.length ?? 0)) * 2;
}
