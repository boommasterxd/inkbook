import type { ElementId, LinearGeometryV1 } from "../model/index";
import type { RuntimeSceneStateV1 } from "../scene/index";
import type { AnnotationDependencyIndexV1 } from "./dependency-index";
import type { AnnotationPatchV1, BatchMemberV1 } from "./types";
import { canonicalValueEqualsV1 } from "./value-equality";

type ComponentSlotV1 = "binding" | "element" | "geometry" | "style";

interface ClaimedSlotsV1 {
  readonly elements: Map<ElementId, Set<ComponentSlotV1>>;
  readonly groups: Set<string>;
  order: boolean;
  appearance: boolean;
}

function claimElement(
  claimed: ClaimedSlotsV1,
  elementId: ElementId,
  slot: ComponentSlotV1,
): boolean {
  const slots = claimed.elements.get(elementId) ?? new Set<ComponentSlotV1>();
  if (
    slots.has("element") ||
    slots.has(slot) ||
    (slot === "element" && slots.size > 0)
  ) {
    return false;
  }
  slots.add(slot);
  claimed.elements.set(elementId, slots);
  return true;
}

function claimOrder(claimed: ClaimedSlotsV1): boolean {
  if (claimed.order) return false;
  claimed.order = true;
  return true;
}

function claimMember(claimed: ClaimedSlotsV1, member: BatchMemberV1): boolean {
  switch (member.kind) {
    case "create-elements":
    case "delete-elements":
      return (
        claimOrder(claimed) &&
        member.elements.every(({ elementId }) =>
          claimElement(claimed, elementId, "element"),
        )
      );
    case "replace-geometry":
    case "replace-linear-geometry":
      return member.changes.every(({ elementId }) =>
        claimElement(claimed, elementId, "geometry"),
      );
    case "replace-style":
      return member.changes.every(({ elementId }) =>
        claimElement(claimed, elementId, "style"),
      );
    case "replace-binding":
      return member.changes.every(({ elementId }) =>
        claimElement(claimed, elementId, "binding"),
      );
    case "replace-object-order":
      return claimOrder(claimed);
    case "replace-groups":
      return member.changes.every(({ groupId }) => {
        if (claimed.groups.has(groupId)) return false;
        claimed.groups.add(groupId);
        return true;
      });
    case "replace-note-appearance":
      if (claimed.appearance) return false;
      claimed.appearance = true;
      return true;
  }
}

function members(patch: AnnotationPatchV1): readonly BatchMemberV1[] {
  return patch.kind === "atomic-batch" ? patch.operations : [patch];
}

export function hasExclusiveComponentChangesV1(
  patch: AnnotationPatchV1,
): boolean {
  const claimed: ClaimedSlotsV1 = {
    elements: new Map<ElementId, Set<ComponentSlotV1>>(),
    groups: new Set<string>(),
    order: false,
    appearance: false,
  };
  return members(patch).every((member) => claimMember(claimed, member));
}

function linearReplacements(
  patch: AnnotationPatchV1,
): ReadonlyMap<
  ElementId,
  { readonly prior: LinearGeometryV1; readonly replacement: LinearGeometryV1 }
> {
  const replacements = new Map<
    ElementId,
    { readonly prior: LinearGeometryV1; readonly replacement: LinearGeometryV1 }
  >();
  for (const member of members(patch)) {
    if (member.kind !== "replace-linear-geometry") continue;
    for (const change of member.changes) {
      replacements.set(change.elementId, {
        prior: change.prior,
        replacement: change.replacement,
      });
    }
  }
  return replacements;
}

export function hasTargetTransformClosureV1(
  scene: RuntimeSceneStateV1,
  dependencies: AnnotationDependencyIndexV1,
  patch: AnnotationPatchV1,
): boolean {
  const lineChanges = linearReplacements(patch);
  for (const member of members(patch)) {
    if (member.kind !== "replace-geometry") continue;
    for (const change of member.changes) {
      const target = scene.elementsById.get(change.elementId);
      if (target === undefined) continue;
      for (const reference of dependencies.attachmentsTo(change.elementId)) {
        const lineChange = lineChanges.get(reference.elementId);
        const priorEndpoint = lineChange?.prior[reference.endpoint];
        const endpoint = lineChange?.replacement[reference.endpoint];
        if (
          priorEndpoint === undefined ||
          endpoint === undefined ||
          endpoint.attachment?.targetElementId !== change.elementId ||
          !canonicalValueEqualsV1(
            endpoint.attachment,
            priorEndpoint.attachment,
          ) ||
          canonicalValueEqualsV1(
            endpoint.fallbackPoint,
            priorEndpoint.fallbackPoint,
          ) ||
          !Number.isFinite(endpoint.fallbackPoint.x) ||
          !Number.isFinite(endpoint.fallbackPoint.y)
        ) {
          return false;
        }
      }
    }
  }
  return true;
}
