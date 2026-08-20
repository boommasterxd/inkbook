import {
  createBindingRevision,
  createGeometryRevision,
  createSceneRevision,
  createStyleRevision,
  validateSceneElementValueV1,
  validateSceneElementV1,
  type SceneElementV1,
  type SceneElementValueV1,
  type SceneRevision,
} from "../model/index";
import {
  PersistentMapV1,
  PersistentSequenceV1,
  type RuntimeSceneStateV1,
} from "../scene/index";
import {
  hasExclusiveComponentChangesV1,
  hasTargetTransformClosureV1,
} from "./batch-validation";
import { validateOperationClosureV1 } from "./closure-validation";
import {
  AnnotationDependencyIndexV1,
  type AnnotationDependencyIndexResultV1,
} from "./dependency-index";
import { createAnnotationOperationV1 } from "./envelopes";
import { OperationDraftV1 } from "./operation-draft";
import type {
  AnnotationOperationResultV1,
  AnnotationOperationV1,
  BatchMemberV1,
  ComponentReplacementV1,
  GroupReplacementV1,
} from "./types";
import { canonicalValueEqualsV1 } from "./value-equality";

function elementValue(element: SceneElementV1): SceneElementValueV1 {
  const { bindingRevision, geometryRevision, styleRevision, ...value } =
    element;
  if (
    !Number.isSafeInteger(bindingRevision) ||
    !Number.isSafeInteger(geometryRevision) ||
    !Number.isSafeInteger(styleRevision)
  ) {
    throw new TypeError("A scene element has an invalid component revision.");
  }
  return value;
}

function materializeCreatedElement(
  value: SceneElementValueV1,
  revision: SceneRevision,
): SceneElementV1 {
  return validateSceneElementV1({
    ...value,
    geometryRevision: createGeometryRevision(revision),
    styleRevision: createStyleRevision(revision),
    bindingRevision: createBindingRevision(revision),
  });
}

function replaceComponent<T>(
  draft: OperationDraftV1,
  changes: readonly ComponentReplacementV1<T>[],
  apply: (
    current: SceneElementV1,
    change: ComponentReplacementV1<T>,
  ) => SceneElementV1 | null,
): boolean {
  for (const change of changes) {
    const current = draft.element(change.elementId);
    if (current === undefined) return false;
    const replacement = apply(current, change);
    if (replacement === null || !draft.setElement(replacement)) return false;
  }
  return true;
}

function validateReplacementValue(
  prior: unknown,
  currentValue: unknown,
): boolean {
  return canonicalValueEqualsV1(currentValue, prior);
}

function applyCreate(
  draft: OperationDraftV1,
  member: Extract<BatchMemberV1, { kind: "create-elements" }>,
  revision: SceneRevision,
): boolean {
  if (!draft.insertOrder(member.placement)) return false;
  for (const value of member.elements) {
    if (draft.element(value.elementId) !== undefined) return false;
    if (!draft.setElement(materializeCreatedElement(value, revision)))
      return false;
  }
  return true;
}

function applyDelete(
  draft: OperationDraftV1,
  member: Extract<BatchMemberV1, { kind: "delete-elements" }>,
): boolean {
  for (const value of member.elements) {
    const current = draft.element(value.elementId);
    if (
      current === undefined ||
      !canonicalValueEqualsV1(elementValue(current), value)
    ) {
      return false;
    }
  }
  if (!draft.deleteOrder(member.priorPlacement)) return false;
  return member.elements.every(({ elementId }) =>
    draft.deleteElement(elementId),
  );
}

function applyGroups(
  draft: OperationDraftV1,
  changes: readonly GroupReplacementV1[],
): boolean {
  for (const change of changes) {
    const current = draft.group(change.groupId) ?? null;
    if (!canonicalValueEqualsV1(current, change.prior)) return false;
  }
  return draft.setGroups(changes);
}

function applyGeometryChanges(
  draft: OperationDraftV1,
  member: Extract<BatchMemberV1, { kind: "replace-geometry" }>,
  revision: SceneRevision,
): boolean {
  return replaceComponent(draft, member.changes, (current, change) => {
    if (
      current.kind === "line" ||
      current.kind === "arrow" ||
      !validateReplacementValue(change.prior, current.geometry)
    )
      return null;
    const value = validateSceneElementValueV1({
      ...elementValue(current),
      geometry: change.replacement,
    });
    return validateSceneElementV1({
      ...value,
      geometryRevision: revision,
      styleRevision: current.styleRevision,
      bindingRevision: current.bindingRevision,
    });
  });
}

function applyStyleChanges(
  draft: OperationDraftV1,
  member: Extract<BatchMemberV1, { kind: "replace-style" }>,
  revision: SceneRevision,
): boolean {
  return replaceComponent(draft, member.changes, (current, change) => {
    if (!validateReplacementValue(change.prior, current.style)) return null;
    const value = validateSceneElementValueV1({
      ...elementValue(current),
      style: change.replacement,
    });
    return validateSceneElementV1({
      ...value,
      geometryRevision: current.geometryRevision,
      styleRevision: revision,
      bindingRevision: current.bindingRevision,
    });
  });
}

function applyBindingChanges(
  draft: OperationDraftV1,
  member: Extract<BatchMemberV1, { kind: "replace-binding" }>,
  revision: SceneRevision,
): boolean {
  return replaceComponent(draft, member.changes, (current, change) => {
    if (!validateReplacementValue(change.prior, current.binding)) return null;
    const value = validateSceneElementValueV1({
      ...elementValue(current),
      binding: change.replacement,
    });
    return validateSceneElementV1({
      ...value,
      geometryRevision: current.geometryRevision,
      styleRevision: current.styleRevision,
      bindingRevision: revision,
    });
  });
}

function applyLinearChanges(
  draft: OperationDraftV1,
  member: Extract<BatchMemberV1, { kind: "replace-linear-geometry" }>,
  revision: SceneRevision,
): boolean {
  return replaceComponent(draft, member.changes, (current, change) => {
    if (
      (current.kind !== "line" && current.kind !== "arrow") ||
      !validateReplacementValue(change.prior, current.geometry)
    )
      return null;
    const value = validateSceneElementValueV1({
      ...elementValue(current),
      geometry: change.replacement,
    });
    return validateSceneElementV1({
      ...value,
      geometryRevision: revision,
      styleRevision: current.styleRevision,
      bindingRevision: current.bindingRevision,
    });
  });
}

function applyMember(
  draft: OperationDraftV1,
  member: BatchMemberV1,
  revision: SceneRevision,
): boolean {
  switch (member.kind) {
    case "create-elements":
      return applyCreate(draft, member, revision);
    case "delete-elements":
      return applyDelete(draft, member);
    case "replace-geometry":
      return applyGeometryChanges(draft, member, revision);
    case "replace-style":
      return applyStyleChanges(draft, member, revision);
    case "replace-binding":
      return applyBindingChanges(draft, member, revision);
    case "replace-linear-geometry":
      return applyLinearChanges(draft, member, revision);
    case "replace-object-order":
      return draft.moveOrder(member.prior, member.replacement);
    case "replace-groups":
      return applyGroups(draft, member.changes);
    case "replace-note-appearance":
      if (!canonicalValueEqualsV1(draft.noteAppearance, member.prior))
        return false;
      draft.noteAppearance = member.replacement;
      draft.noteAppearanceChanged = true;
      return true;
  }
}

function invalid(
  code: "invalid-operation" | "resource-limit" | "stale-scene",
): AnnotationOperationResultV1 {
  return Object.freeze({ ok: false, code });
}

export function createAnnotationDependencyIndexV1(
  scene: RuntimeSceneStateV1,
): AnnotationDependencyIndexResultV1 {
  return AnnotationDependencyIndexV1.fromScene(scene);
}

export function applyAnnotationOperationV1(
  scene: RuntimeSceneStateV1,
  dependencies: AnnotationDependencyIndexV1,
  operation: AnnotationOperationV1,
): AnnotationOperationResultV1 {
  const validated = createAnnotationOperationV1(operation);
  if (!validated.ok) return invalid(validated.code);
  if (!dependencies.isBoundTo(scene)) return invalid("invalid-operation");
  if (scene.revision !== validated.value.expectedSceneRevision)
    return invalid("stale-scene");
  if (
    !hasExclusiveComponentChangesV1(validated.value.patch) ||
    !hasTargetTransformClosureV1(scene, dependencies, validated.value.patch)
  ) {
    return invalid("invalid-operation");
  }
  if (
    scene.revision === Number.MAX_SAFE_INTEGER ||
    !(scene.elementsById instanceof PersistentMapV1) ||
    !(scene.groupsById instanceof PersistentMapV1) ||
    !(scene.objectOrder instanceof PersistentSequenceV1)
  )
    return invalid("resource-limit");
  try {
    const revision = createSceneRevision(scene.revision + 1);
    const draft = new OperationDraftV1(scene, dependencies, revision);
    const members =
      validated.value.patch.kind === "atomic-batch"
        ? validated.value.patch.operations
        : [validated.value.patch];
    for (const member of members)
      if (!applyMember(draft, member, revision))
        return invalid(
          draft.resourceLimited ? "resource-limit" : "invalid-operation",
        );
    const publication = draft.publish();
    const replacement = publication.scene;
    const closure = validateOperationClosureV1(
      replacement,
      draft.dependencies,
      draft.affectedElementIds,
      draft.affectedGroupIds,
    );
    if (!closure.ok)
      return invalid(
        closure.resourceLimit ? "resource-limit" : "invalid-operation",
      );
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        scene: replacement,
        dependencies: publication.index,
        changes: Object.freeze({
          elementIds: Object.freeze([...draft.affectedElementIds]),
          groupIds: Object.freeze([...draft.affectedGroupIds]),
          objectOrderChanged: draft.objectOrderChanged,
          noteAppearanceChanged: draft.noteAppearanceChanged,
        }),
      }),
    });
  } catch (error) {
    return invalid(
      error instanceof RangeError ? "resource-limit" : "invalid-operation",
    );
  }
}
