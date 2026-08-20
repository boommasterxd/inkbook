import type {
  AnnotationPatchV1,
  BatchMemberV1,
  ComponentReplacementV1,
  GroupReplacementV1,
} from "./types";

function swapReplacement<T>(
  change: ComponentReplacementV1<T>,
): ComponentReplacementV1<T> {
  return Object.freeze({
    elementId: change.elementId,
    prior: change.replacement,
    replacement: change.prior,
  });
}

function invertBatchMember(member: BatchMemberV1): BatchMemberV1 {
  switch (member.kind) {
    case "create-elements":
      return Object.freeze({
        kind: "delete-elements",
        elements: member.elements,
        priorPlacement: member.placement,
      });
    case "delete-elements":
      return Object.freeze({
        kind: "create-elements",
        elements: member.elements,
        placement: member.priorPlacement,
      });
    case "replace-geometry":
    case "replace-style":
    case "replace-binding":
    case "replace-linear-geometry":
      return Object.freeze({
        kind: member.kind,
        changes: Object.freeze(member.changes.map(swapReplacement)),
      }) as BatchMemberV1;
    case "replace-object-order":
      return Object.freeze({
        kind: "replace-object-order",
        prior: member.replacement,
        replacement: member.prior,
      });
    case "replace-groups":
      return Object.freeze({
        kind: "replace-groups",
        changes: Object.freeze(
          member.changes.map((change): GroupReplacementV1 =>
            Object.freeze({
              groupId: change.groupId,
              prior: change.replacement,
              replacement: change.prior,
            }),
          ),
        ),
      });
    case "replace-note-appearance":
      return Object.freeze({
        kind: "replace-note-appearance",
        prior: member.replacement,
        replacement: member.prior,
      });
  }
}

export function invertAnnotationPatchV1(
  patch: AnnotationPatchV1,
): AnnotationPatchV1 {
  if (patch.kind !== "atomic-batch") {
    return invertBatchMember(patch);
  }
  return Object.freeze({
    kind: "atomic-batch",
    operations: Object.freeze(
      [...patch.operations].reverse().map(invertBatchMember),
    ),
  });
}
