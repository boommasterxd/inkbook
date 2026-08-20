import type {
  ElementId,
  GroupId,
  SceneElementV1,
  SceneRevision,
} from "../model/index";
import {
  PersistentMapV1,
  PersistentSequenceV1,
  SCENE_RESOURCE_LIMITS_V1,
  updateRuntimeSceneStateV1,
  type GroupRecordV1,
  type NoteAppearanceV1,
  type RuntimeSceneStateV1,
} from "../scene/index";
import {
  addAttachmentReferencesV1,
  attachmentReferencesForV1,
  removeAttachmentReferencesV1,
  type AttachedEndpointReferenceV1,
} from "./attachment-references";
import { ObjectOrderIndexV1 } from "./object-order-index";
import type { GroupReplacementV1, OrderPlacementV1 } from "./types";
import { canonicalValueEqualsV1 } from "./value-equality";

export type { AttachedEndpointReferenceV1 } from "./attachment-references";

type SceneObjectIdV1 = ElementId | GroupId;

interface SceneAggregateV1 {
  readonly recordCount: number;
  readonly strokePointCount: number;
}

interface StagedSceneStateV1 {
  readonly elementChanges: PersistentMapV1<ElementId, SceneElementV1 | null>;
  readonly groupChanges: PersistentMapV1<GroupId, GroupRecordV1 | null>;
  readonly objectOrder: PersistentSequenceV1<ElementId>;
}

interface SceneBindingV1 {
  readonly scene: RuntimeSceneStateV1;
  readonly published: boolean;
  readonly staged: StagedSceneStateV1;
}

const DELETE_ORDER = Symbol("delete-annotation-order");
const INSERT_ORDER = Symbol("insert-annotation-order");
const MOVE_ORDER = Symbol("move-annotation-order");
const PUBLISH_SCENE = Symbol("publish-annotation-scene");
const REPLACE_ELEMENT = Symbol("replace-annotation-element");
const REPLACE_GROUPS = Symbol("replace-annotation-groups");

type DependencyOrderResultV1 =
  | {
      readonly ok: true;
      readonly index: AnnotationDependencyIndexV1;
      readonly sequence: PersistentSequenceV1<ElementId>;
    }
  | {
      readonly ok: false;
      readonly code: "invalid-placement" | "resource-limit";
    };

export type AnnotationDependencyIndexResultV1 =
  | { readonly ok: true; readonly value: AnnotationDependencyIndexV1 }
  | {
      readonly ok: false;
      readonly code: "invalid-operation" | "resource-limit";
    };

function strokePointCount(element: SceneElementV1 | null): number {
  return element?.kind === "pen" || element?.kind === "highlighter"
    ? element.geometry.stroke.pointCount
    : 0;
}

function aggregateWithinLimits(aggregate: SceneAggregateV1): boolean {
  return (
    aggregate.recordCount >= 0 &&
    aggregate.recordCount <= SCENE_RESOURCE_LIMITS_V1.maxRecords &&
    aggregate.strokePointCount >= 0 &&
    aggregate.strokePointCount <= SCENE_RESOURCE_LIMITS_V1.maxStrokePoints
  );
}

export class AnnotationDependencyIndexV1 {
  public readonly objectOrder: ObjectOrderIndexV1;
  public readonly recordCount: number;
  public readonly strokePointCount: number;
  readonly #parentByChildId: PersistentMapV1<SceneObjectIdV1, GroupId>;
  readonly #attachmentsByTargetId: PersistentMapV1<
    ElementId,
    readonly AttachedEndpointReferenceV1[]
  >;
  readonly #scene: RuntimeSceneStateV1;
  readonly #published: boolean;
  readonly #staged: StagedSceneStateV1;

  private constructor(
    objectOrder: ObjectOrderIndexV1,
    parentByChildId: PersistentMapV1<SceneObjectIdV1, GroupId>,
    attachmentsByTargetId: PersistentMapV1<
      ElementId,
      readonly AttachedEndpointReferenceV1[]
    >,
    aggregate: SceneAggregateV1,
    binding: SceneBindingV1,
  ) {
    this.objectOrder = objectOrder;
    this.#parentByChildId = parentByChildId;
    this.#attachmentsByTargetId = attachmentsByTargetId;
    this.recordCount = aggregate.recordCount;
    this.strokePointCount = aggregate.strokePointCount;
    this.#scene = binding.scene;
    this.#published = binding.published;
    this.#staged = binding.staged;
    Object.freeze(this);
  }

  public static fromScene(
    scene: RuntimeSceneStateV1,
  ): AnnotationDependencyIndexResultV1 {
    const recordCount = scene.elementsById.size + scene.groupsById.size;
    if (recordCount > SCENE_RESOURCE_LIMITS_V1.maxRecords) {
      return Object.freeze({ ok: false, code: "resource-limit" });
    }
    const order = ObjectOrderIndexV1.fromSequence(scene.objectOrder);
    if (order === null)
      return Object.freeze({ ok: false, code: "invalid-operation" });
    let parents = PersistentMapV1.empty<SceneObjectIdV1, GroupId>();
    for (const [, group] of scene.groupsById.entriesByCanonicalKey()) {
      for (const childId of group.childIds) {
        if (parents.has(childId)) {
          return Object.freeze({ ok: false, code: "invalid-operation" });
        }
        parents = parents.set(childId, group.groupId);
      }
    }
    let attachments = PersistentMapV1.empty<
      ElementId,
      readonly AttachedEndpointReferenceV1[]
    >();
    let strokePoints = 0;
    for (const [, element] of scene.elementsById.entriesByCanonicalKey()) {
      strokePoints += strokePointCount(element);
      if (strokePoints > SCENE_RESOURCE_LIMITS_V1.maxStrokePoints) {
        return Object.freeze({ ok: false, code: "resource-limit" });
      }
      const update = addAttachmentReferencesV1(
        attachments,
        attachmentReferencesForV1(element),
      );
      if (update === null) {
        return Object.freeze({ ok: false, code: "resource-limit" });
      }
      attachments = update;
    }
    return Object.freeze({
      ok: true,
      value: new AnnotationDependencyIndexV1(
        order,
        parents,
        attachments,
        {
          recordCount,
          strokePointCount: strokePoints,
        },
        {
          scene,
          published: true,
          staged: emptyStagedScene(scene),
        },
      ),
    });
  }

  public parentOf(childId: SceneObjectIdV1): GroupId | undefined {
    return this.#parentByChildId.get(childId);
  }

  public isBoundTo(scene: RuntimeSceneStateV1): boolean {
    return (
      this.#published &&
      this.#scene === scene &&
      this.#scene.revision === scene.revision
    );
  }

  public [PUBLISH_SCENE](
    revision: SceneRevision,
    noteAppearance: NoteAppearanceV1,
  ): {
    readonly scene: RuntimeSceneStateV1;
    readonly index: AnnotationDependencyIndexV1;
  } {
    const replacementScene = updateRuntimeSceneStateV1(this.#scene, {
      revision,
      elements: this.#staged.elementChanges.entriesByCanonicalKey(),
      groups: this.#staged.groupChanges.entriesByCanonicalKey(),
      objectOrder: this.#staged.objectOrder,
      noteAppearance,
    }).scene;
    if (
      replacementScene.revision !== this.#scene.revision + 1 ||
      replacementScene.elementsById.size + replacementScene.groupsById.size !==
        this.recordCount ||
      replacementScene.objectOrder.length !== replacementScene.elementsById.size
    ) {
      throw new TypeError("Dependency index publication binding is invalid.");
    }
    return Object.freeze({
      scene: replacementScene,
      index: new AnnotationDependencyIndexV1(
        this.objectOrder,
        this.#parentByChildId,
        this.#attachmentsByTargetId,
        this.aggregate(),
        {
          scene: replacementScene,
          published: true,
          staged: emptyStagedScene(replacementScene),
        },
      ),
    });
  }

  public attachmentsTo(
    targetElementId: ElementId,
  ): readonly AttachedEndpointReferenceV1[] {
    return (
      this.#attachmentsByTargetId.get(targetElementId) ?? Object.freeze([])
    );
  }

  public [REPLACE_GROUPS](
    changes: readonly GroupReplacementV1[],
  ): AnnotationDependencyIndexResultV1 {
    for (const change of changes) {
      const current = this.stagedGroup(change.groupId);
      if (!canonicalValueEqualsV1(current, change.prior)) {
        return Object.freeze({ ok: false, code: "invalid-operation" });
      }
    }
    const recordCount = changes.reduce(
      (count, change) =>
        count +
        Number(change.replacement !== null) -
        Number(change.prior !== null),
      this.recordCount,
    );
    const aggregate = { recordCount, strokePointCount: this.strokePointCount };
    if (!aggregateWithinLimits(aggregate)) {
      return Object.freeze({ ok: false, code: "resource-limit" });
    }
    let parents = this.#parentByChildId;
    for (const change of changes) {
      for (const childId of change.prior?.childIds ?? []) {
        if (parents.get(childId) === change.groupId)
          parents = parents.delete(childId);
      }
    }
    for (const change of changes) {
      for (const childId of change.replacement?.childIds ?? []) {
        if (parents.has(childId)) {
          return Object.freeze({ ok: false, code: "invalid-operation" });
        }
        parents = parents.set(childId, change.groupId);
      }
    }
    return Object.freeze({
      ok: true,
      value: new AnnotationDependencyIndexV1(
        this.objectOrder,
        parents,
        this.#attachmentsByTargetId,
        aggregate,
        this.stagedBinding({
          ...this.#staged,
          groupChanges: setGroupChanges(this.#staged.groupChanges, changes),
        }),
      ),
    });
  }

  public [REPLACE_ELEMENT](
    prior: SceneElementV1 | null,
    replacement: SceneElementV1 | null,
  ): AnnotationDependencyIndexResultV1 {
    const elementId = replacement?.elementId ?? prior?.elementId;
    if (
      elementId === undefined ||
      (prior !== null &&
        replacement !== null &&
        prior.elementId !== replacement.elementId)
    ) {
      return Object.freeze({ ok: false, code: "invalid-operation" });
    }
    if (!canonicalValueEqualsV1(this.stagedElement(elementId), prior)) {
      return Object.freeze({ ok: false, code: "invalid-operation" });
    }
    const aggregate = {
      recordCount:
        this.recordCount +
        Number(replacement !== null) -
        Number(prior !== null),
      strokePointCount:
        this.strokePointCount -
        strokePointCount(prior) +
        strokePointCount(replacement),
    };
    if (!aggregateWithinLimits(aggregate)) {
      return Object.freeze({ ok: false, code: "resource-limit" });
    }
    let attachments = removeAttachmentReferencesV1(
      this.#attachmentsByTargetId,
      attachmentReferencesForV1(prior),
    );
    const updated = addAttachmentReferencesV1(
      attachments,
      attachmentReferencesForV1(replacement),
    );
    if (updated === null) {
      return Object.freeze({ ok: false, code: "resource-limit" });
    }
    attachments = updated;
    return Object.freeze({
      ok: true,
      value: new AnnotationDependencyIndexV1(
        this.objectOrder,
        this.#parentByChildId,
        attachments,
        aggregate,
        this.stagedBinding({
          ...this.#staged,
          elementChanges: this.#staged.elementChanges.set(
            elementId,
            replacement,
          ),
        }),
      ),
    });
  }

  private aggregate(): SceneAggregateV1 {
    return {
      recordCount: this.recordCount,
      strokePointCount: this.strokePointCount,
    };
  }

  public [INSERT_ORDER](placement: OrderPlacementV1): DependencyOrderResultV1 {
    const update = this.objectOrder.insert(placement);
    if (!update.ok) return update;
    const sequence = this.#staged.objectOrder.spliceWithStats(
      update.value.start,
      0,
      placement.movedElementIds,
    ).sequence;
    return this.orderResult(update.value.index, sequence);
  }

  public [DELETE_ORDER](placement: OrderPlacementV1): DependencyOrderResultV1 {
    const update = this.objectOrder.delete(placement);
    if (!update.ok) return update;
    const sequence = this.#staged.objectOrder.spliceWithStats(
      update.value.start,
      placement.movedElementIds.length,
      [],
    ).sequence;
    return this.orderResult(update.value.index, sequence);
  }

  public [MOVE_ORDER](
    prior: OrderPlacementV1,
    replacement: OrderPlacementV1,
  ): DependencyOrderResultV1 {
    const update = this.objectOrder.move(prior, replacement);
    if (!update.ok) return update;
    const sequence = this.#staged.objectOrder.moveWithStats(
      update.value.start,
      prior.movedElementIds.length,
      update.value.destinationAfterRemoval,
    ).sequence;
    return this.orderResult(update.value.index, sequence);
  }

  private orderResult(
    objectOrder: ObjectOrderIndexV1,
    sequence: PersistentSequenceV1<ElementId>,
  ): DependencyOrderResultV1 {
    return Object.freeze({
      ok: true,
      index: new AnnotationDependencyIndexV1(
        objectOrder,
        this.#parentByChildId,
        this.#attachmentsByTargetId,
        this.aggregate(),
        this.stagedBinding({ ...this.#staged, objectOrder: sequence }),
      ),
      sequence,
    });
  }

  private stagedElement(elementId: ElementId): SceneElementV1 | null {
    if (this.#staged.elementChanges.has(elementId)) {
      return this.#staged.elementChanges.get(elementId) ?? null;
    }
    return this.#scene.elementsById.get(elementId) ?? null;
  }

  private stagedGroup(groupId: GroupId): GroupRecordV1 | null {
    if (this.#staged.groupChanges.has(groupId)) {
      return this.#staged.groupChanges.get(groupId) ?? null;
    }
    return this.#scene.groupsById.get(groupId) ?? null;
  }

  private stagedBinding(staged: StagedSceneStateV1): SceneBindingV1 {
    return { scene: this.#scene, published: false, staged };
  }
}

export function deleteAnnotationOrderV1(
  index: AnnotationDependencyIndexV1,
  placement: OrderPlacementV1,
): DependencyOrderResultV1 {
  return index[DELETE_ORDER](placement);
}

export function insertAnnotationOrderV1(
  index: AnnotationDependencyIndexV1,
  placement: OrderPlacementV1,
): DependencyOrderResultV1 {
  return index[INSERT_ORDER](placement);
}

export function moveAnnotationOrderV1(
  index: AnnotationDependencyIndexV1,
  prior: OrderPlacementV1,
  replacement: OrderPlacementV1,
): DependencyOrderResultV1 {
  return index[MOVE_ORDER](prior, replacement);
}

export function publishAnnotationSceneV1(
  index: AnnotationDependencyIndexV1,
  revision: SceneRevision,
  noteAppearance: NoteAppearanceV1,
): ReturnType<AnnotationDependencyIndexV1[typeof PUBLISH_SCENE]> {
  return index[PUBLISH_SCENE](revision, noteAppearance);
}

export function replaceAnnotationElementV1(
  index: AnnotationDependencyIndexV1,
  prior: SceneElementV1 | null,
  replacement: SceneElementV1 | null,
): AnnotationDependencyIndexResultV1 {
  return index[REPLACE_ELEMENT](prior, replacement);
}

export function replaceAnnotationGroupsV1(
  index: AnnotationDependencyIndexV1,
  changes: readonly GroupReplacementV1[],
): AnnotationDependencyIndexResultV1 {
  return index[REPLACE_GROUPS](changes);
}

function emptyStagedScene(scene: RuntimeSceneStateV1): StagedSceneStateV1 {
  return {
    elementChanges: PersistentMapV1.empty(),
    groupChanges: PersistentMapV1.empty(),
    objectOrder: scene.objectOrder as PersistentSequenceV1<ElementId>,
  };
}

function setGroupChanges(
  current: PersistentMapV1<GroupId, GroupRecordV1 | null>,
  changes: readonly GroupReplacementV1[],
): PersistentMapV1<GroupId, GroupRecordV1 | null> {
  let result = current;
  for (const change of changes) {
    result = result.set(change.groupId, change.replacement);
  }
  return result;
}
