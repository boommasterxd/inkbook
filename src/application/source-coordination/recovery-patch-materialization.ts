import {
  validateAnnotationPatchV1,
  type AnnotationPatchV1,
  type BatchMemberV1,
} from "../../domain/operations";
import type {
  ElementBinding,
  SceneElementValueV1,
  TextBoundaryAnchor,
} from "../../domain/model";
import { commandFailure, commandSuccess } from "../note-session/results";
import type { CommandResultV1 } from "../note-session/types";
import { mapSourceOffset } from "./offset-map";
import type { RecoveryPatchMaterializationWorkV1 } from "./recovery-materialization";

const MAXIMUM_FREEZE_INSPECTION_OBJECTS = 100_000;

export function materializeAnnotationPatchThroughOffsetMapV1(
  work: RecoveryPatchMaterializationWorkV1,
): CommandResultV1<AnnotationPatchV1> {
  return materializePatchThroughMap({
    offsetMap: work.offsetMap,
    patch: work.patch,
    priorUtf16Length: work.checkpoint.priorUtf16Length,
    replacementUtf16Length: work.checkpoint.replacementUtf16Length,
  });
}

export interface SourcePatchMaterializationWorkV1 {
  readonly offsetMap: RecoveryPatchMaterializationWorkV1["offsetMap"];
  readonly patch: AnnotationPatchV1;
  readonly priorUtf16Length: number;
  readonly replacementUtf16Length: number;
}

export function materializeAnnotationPatchThroughSourceMapV1(
  work: SourcePatchMaterializationWorkV1,
): CommandResultV1<AnnotationPatchV1> {
  return materializePatchThroughMap(work);
}

function materializePatchThroughMap(
  work: SourcePatchMaterializationWorkV1,
): CommandResultV1<AnnotationPatchV1> {
  const validated = validateAnnotationPatchV1(work.patch);
  if (!validated.ok) return commandFailure("recovery-unavailable");
  let source: AnnotationPatchV1;
  let mapped: CommandResultV1<AnnotationPatchV1>;
  try {
    source = isDeepFrozen(work.patch) ? work.patch : validated.value;
    mapped = mapPatch(source, work);
  } catch {
    return commandFailure("recovery-unavailable");
  }
  if (!mapped.ok) return mapped;
  if (mapped.value === source) return commandSuccess(source);
  const finalValidation = validateAnnotationPatchV1(mapped.value);
  return finalValidation.ok
    ? commandSuccess(mapped.value)
    : commandFailure("recovery-unavailable");
}

function mapPatch(
  patch: AnnotationPatchV1,
  work: SourcePatchMaterializationWorkV1,
): CommandResultV1<AnnotationPatchV1> {
  if (patch.kind !== "atomic-batch") return mapMember(patch, work);
  const operations: BatchMemberV1[] = [];
  let changed = false;
  for (const operation of patch.operations) {
    const mapped = mapMember(operation, work);
    if (!mapped.ok) return mapped;
    operations.push(mapped.value);
    changed ||= mapped.value !== operation;
  }
  return commandSuccess(
    changed
      ? Object.freeze({
          kind: "atomic-batch" as const,
          operations: Object.freeze(operations),
        })
      : patch,
  );
}

function mapMember(
  member: BatchMemberV1,
  work: SourcePatchMaterializationWorkV1,
): CommandResultV1<BatchMemberV1> {
  if (member.kind === "create-elements" || member.kind === "delete-elements") {
    return mapElementMember(member, work);
  }
  if (member.kind === "replace-binding") {
    const changes = [];
    let changed = false;
    for (const replacement of member.changes) {
      const prior = mapBinding(replacement.prior, work);
      if (!prior.ok) return prior;
      const next = mapBinding(replacement.replacement, work);
      if (!next.ok) return next;
      const mapped =
        prior.value === replacement.prior &&
        next.value === replacement.replacement
          ? replacement
          : Object.freeze({
              elementId: replacement.elementId,
              prior: prior.value,
              replacement: next.value,
            });
      changes.push(mapped);
      changed ||= mapped !== replacement;
    }
    return commandSuccess(
      changed
        ? Object.freeze({
            changes: Object.freeze(changes),
            kind: "replace-binding" as const,
          })
        : member,
    );
  }
  return commandSuccess(member);
}

function mapElementMember(
  member: Extract<
    BatchMemberV1,
    { readonly kind: "create-elements" | "delete-elements" }
  >,
  work: SourcePatchMaterializationWorkV1,
): CommandResultV1<BatchMemberV1> {
  const elements: SceneElementValueV1[] = [];
  let changed = false;
  for (const element of member.elements) {
    const binding = mapBinding(element.binding, work);
    if (!binding.ok) return binding;
    const mapped =
      binding.value === element.binding
        ? element
        : Object.freeze({ ...element, binding: binding.value });
    elements.push(mapped);
    changed ||= mapped !== element;
  }
  if (!changed) return commandSuccess(member);
  const frozenElements = Object.freeze(elements);
  return commandSuccess(Object.freeze({ ...member, elements: frozenElements }));
}

function mapBinding(
  binding: ElementBinding,
  work: SourcePatchMaterializationWorkV1,
): CommandResultV1<ElementBinding> {
  if (binding.kind === "fixed") return commandSuccess(binding);
  if (binding.kind === "text-position") {
    const anchor = mapAnchor(binding.anchor, work);
    if (!anchor.ok) return anchor;
    return commandSuccess(
      anchor.value === binding.anchor
        ? binding
        : Object.freeze({ ...binding, anchor: anchor.value }),
    );
  }
  const start = mapAnchor(binding.start, work);
  if (!start.ok) return start;
  const end = mapAnchor(binding.end, work);
  if (!end.ok) return end;
  if (
    (binding.start.utf16Offset < binding.end.utf16Offset &&
      start.value.utf16Offset >= end.value.utf16Offset) ||
    start.value.utf16Offset > end.value.utf16Offset
  ) {
    return commandFailure("recovery-unavailable");
  }
  return commandSuccess(
    start.value === binding.start && end.value === binding.end
      ? binding
      : Object.freeze({ ...binding, end: end.value, start: start.value }),
  );
}

function mapAnchor(
  anchor: TextBoundaryAnchor,
  work: SourcePatchMaterializationWorkV1,
): CommandResultV1<TextBoundaryAnchor> {
  const mapped = mapSourceOffset(
    work.offsetMap,
    work.priorUtf16Length,
    work.replacementUtf16Length,
    anchor.utf16Offset,
    anchor.association,
  );
  if (!mapped.ok) return commandFailure("recovery-unavailable");
  return commandSuccess(
    mapped.value === anchor.utf16Offset
      ? anchor
      : Object.freeze({ ...anchor, utf16Offset: mapped.value }),
  );
}

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  const pending: object[] = [value];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    if (
      visited.size >= MAXIMUM_FREEZE_INSPECTION_OBJECTS ||
      !Object.isFrozen(current)
    ) {
      return false;
    }
    visited.add(current);
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(current),
    )) {
      if ("value" in descriptor && descriptor.value !== null) {
        const nested: unknown = descriptor.value;
        if (nested !== null && typeof nested === "object") {
          pending.push(nested);
        }
      }
    }
  }
  return true;
}
