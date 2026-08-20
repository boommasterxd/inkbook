import type {
  ElementId,
  LinearGeometryV1,
  SceneElementV1,
} from "../model/index";
import { PersistentMapV1 } from "../scene/index";

const MAX_ATTACHMENTS_PER_TARGET_V1 = 1_024;

export interface AttachedEndpointReferenceV1 {
  readonly elementId: ElementId;
  readonly endpoint: "start" | "end";
}

type AttachmentMapV1 = PersistentMapV1<
  ElementId,
  readonly AttachedEndpointReferenceV1[]
>;
type TargetReferenceV1 = readonly [ElementId, AttachedEndpointReferenceV1];

function isLinearElement(element: SceneElementV1): element is SceneElementV1 & {
  readonly kind: "line" | "arrow";
  readonly geometry: LinearGeometryV1;
} {
  return element.kind === "line" || element.kind === "arrow";
}

function referenceEquals(
  left: AttachedEndpointReferenceV1,
  right: AttachedEndpointReferenceV1,
): boolean {
  return left.elementId === right.elementId && left.endpoint === right.endpoint;
}

export function attachmentReferencesForV1(
  element: SceneElementV1 | null,
): readonly TargetReferenceV1[] {
  if (element === null || !isLinearElement(element)) return Object.freeze([]);
  const references: TargetReferenceV1[] = [];
  for (const endpoint of ["start", "end"] as const) {
    const attachment = element.geometry[endpoint].attachment;
    if (attachment !== null) {
      references.push(
        Object.freeze([
          attachment.targetElementId,
          Object.freeze({ elementId: element.elementId, endpoint }),
        ]),
      );
    }
  }
  return Object.freeze(references);
}

export function removeAttachmentReferencesV1(
  current: AttachmentMapV1,
  references: readonly TargetReferenceV1[],
): AttachmentMapV1 {
  let result = current;
  for (const [targetId, removed] of references) {
    const remaining = (result.get(targetId) ?? []).filter(
      (candidate) => !referenceEquals(candidate, removed),
    );
    result =
      remaining.length === 0
        ? result.delete(targetId)
        : result.set(targetId, Object.freeze(remaining));
  }
  return result;
}

export function addAttachmentReferencesV1(
  current: AttachmentMapV1,
  references: readonly TargetReferenceV1[],
): AttachmentMapV1 | null {
  let result = current;
  for (const [targetId, added] of references) {
    const existing = result.get(targetId) ?? [];
    if (
      existing.length >= MAX_ATTACHMENTS_PER_TARGET_V1 ||
      existing.some((candidate) => referenceEquals(candidate, added))
    ) {
      return null;
    }
    result = result.set(targetId, Object.freeze([...existing, added]));
  }
  return result;
}
