import type {
  ElementId,
  GroupId,
  ObjectPortIdV1,
  SceneElementV1,
} from "../model/index";
import {
  SCENE_RESOURCE_LIMITS_V1,
  type RuntimeSceneStateV1,
} from "../scene/index";
import type { AnnotationDependencyIndexV1 } from "./dependency-index";

const MAX_GROUP_DEPTH_V1 = 32;

export type ClosureValidationResultV1 =
  | { readonly ok: true }
  | { readonly ok: false; readonly resourceLimit: boolean };

interface FlattenStateV1 {
  readonly active: Set<GroupId>;
  readonly leaves: ElementId[];
  visited: number;
}

function validPort(target: SceneElementV1, portId: ObjectPortIdV1): boolean {
  if (
    target.kind === "rectangle" ||
    target.kind === "ellipse" ||
    target.kind === "triangle" ||
    target.kind === "diamond" ||
    target.kind === "octagon" ||
    target.kind === "table"
  ) {
    return portId.startsWith("area:");
  }
  if (target.kind === "axes-2d") {
    return portId !== "axes:z-positive" && portId.startsWith("axes:");
  }
  return target.kind === "axes-3d" && portId.startsWith("axes:");
}

function validateLinearAttachments(
  element: SceneElementV1,
  scene: RuntimeSceneStateV1,
): boolean {
  if (element.kind !== "line" && element.kind !== "arrow") return true;
  for (const endpoint of [element.geometry.start, element.geometry.end]) {
    const attachment = endpoint.attachment;
    if (attachment === null) continue;
    const target = scene.elementsById.get(attachment.targetElementId);
    if (target === undefined || !validPort(target, attachment.portId))
      return false;
  }
  return true;
}

function flattenGroup(
  groupId: GroupId,
  scene: RuntimeSceneStateV1,
  dependencies: AnnotationDependencyIndexV1,
  depth: number,
  state: FlattenStateV1,
): ClosureValidationResultV1 {
  if (depth > MAX_GROUP_DEPTH_V1 || state.active.has(groupId)) {
    return Object.freeze({
      ok: false,
      resourceLimit: depth > MAX_GROUP_DEPTH_V1,
    });
  }
  const group = scene.groupsById.get(groupId);
  if (group === undefined)
    return Object.freeze({ ok: false, resourceLimit: false });
  state.active.add(groupId);
  state.visited += 1;
  if (state.visited > SCENE_RESOURCE_LIMITS_V1.maxRecords) {
    return Object.freeze({ ok: false, resourceLimit: true });
  }
  for (const childId of group.childIds) {
    if (dependencies.parentOf(childId) !== groupId) {
      return Object.freeze({ ok: false, resourceLimit: false });
    }
    if (childId.startsWith("el_")) {
      if (!scene.elementsById.has(childId as ElementId)) {
        return Object.freeze({ ok: false, resourceLimit: false });
      }
      state.leaves.push(childId as ElementId);
    } else {
      const result = flattenGroup(
        childId as GroupId,
        scene,
        dependencies,
        depth + 1,
        state,
      );
      if (!result.ok) return result;
    }
  }
  state.active.delete(groupId);
  return Object.freeze({ ok: true });
}

function validateLeafBlock(
  groupId: GroupId,
  scene: RuntimeSceneStateV1,
  dependencies: AnnotationDependencyIndexV1,
): ClosureValidationResultV1 {
  const state: FlattenStateV1 = {
    active: new Set<GroupId>(),
    leaves: [],
    visited: 0,
  };
  const flattened = flattenGroup(groupId, scene, dependencies, 1, state);
  if (!flattened.ok || state.leaves.length === 0) return flattened;
  const firstElementId = state.leaves[0];
  if (firstElementId === undefined) {
    return Object.freeze({ ok: false, resourceLimit: false });
  }
  const first = dependencies.objectOrder.positionOf(firstElementId);
  if (first < 0) return Object.freeze({ ok: false, resourceLimit: false });
  for (let offset = 0; offset < state.leaves.length; offset += 1) {
    const elementId = state.leaves[offset];
    if (
      elementId === undefined ||
      dependencies.objectOrder.positionOf(elementId) !== first + offset
    ) {
      return Object.freeze({ ok: false, resourceLimit: false });
    }
  }
  return Object.freeze({ ok: true });
}

function validateAffectedElements(
  scene: RuntimeSceneStateV1,
  dependencies: AnnotationDependencyIndexV1,
  affectedElementIds: ReadonlySet<ElementId>,
): boolean {
  for (const elementId of affectedElementIds) {
    const element = scene.elementsById.get(elementId);
    if (element === undefined) {
      if (
        dependencies.objectOrder.positionOf(elementId) >= 0 ||
        dependencies.parentOf(elementId) !== undefined ||
        dependencies.attachmentsTo(elementId).length > 0
      ) {
        return false;
      }
      continue;
    }
    if (
      dependencies.objectOrder.positionOf(elementId) < 0 ||
      !validateLinearAttachments(element, scene)
    ) {
      return false;
    }
    for (const reference of dependencies.attachmentsTo(elementId)) {
      const dependent = scene.elementsById.get(reference.elementId);
      if (
        dependent === undefined ||
        (dependent.kind !== "line" && dependent.kind !== "arrow") ||
        dependent.geometry[reference.endpoint].attachment?.targetElementId !==
          elementId
      ) {
        return false;
      }
      const attachment = dependent.geometry[reference.endpoint].attachment;
      if (attachment === null || !validPort(element, attachment.portId))
        return false;
    }
  }
  return true;
}

export function validateOperationClosureV1(
  scene: RuntimeSceneStateV1,
  dependencies: AnnotationDependencyIndexV1,
  affectedElementIds: ReadonlySet<ElementId>,
  affectedGroupIds: ReadonlySet<GroupId>,
): ClosureValidationResultV1 {
  if (
    scene.elementsById.size !== scene.objectOrder.length ||
    !validateAffectedElements(scene, dependencies, affectedElementIds)
  ) {
    return Object.freeze({ ok: false, resourceLimit: false });
  }
  for (const groupId of affectedGroupIds) {
    if (!scene.groupsById.has(groupId)) {
      if (dependencies.parentOf(groupId) !== undefined) {
        return Object.freeze({ ok: false, resourceLimit: false });
      }
      continue;
    }
    const result = validateLeafBlock(groupId, scene, dependencies);
    if (!result.ok) return result;
  }
  return Object.freeze({ ok: true });
}
