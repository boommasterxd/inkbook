import type {
  ElementId,
  GroupId,
  SceneElementV1,
  SceneRevision,
} from "../model/index";
import {
  PersistentSequenceV1,
  type GroupRecordV1,
  type NoteAppearanceV1,
  type RuntimeSceneStateV1,
} from "../scene/index";
import {
  AnnotationDependencyIndexV1,
  deleteAnnotationOrderV1,
  insertAnnotationOrderV1,
  moveAnnotationOrderV1,
  publishAnnotationSceneV1,
  replaceAnnotationElementV1,
  replaceAnnotationGroupsV1,
} from "./dependency-index";
import type { GroupReplacementV1, OrderPlacementV1 } from "./types";

type ChangedElementV1 = SceneElementV1 | null;
type ChangedGroupV1 = GroupRecordV1 | null;
const MAX_GROUP_DEPTH_V1 = 32;

export class OperationDraftV1 {
  public objectOrder: PersistentSequenceV1<ElementId>;
  public dependencies: AnnotationDependencyIndexV1;
  public noteAppearance: NoteAppearanceV1;
  public readonly affectedElementIds = new Set<ElementId>();
  public readonly affectedGroupIds = new Set<GroupId>();
  public objectOrderChanged = false;
  public noteAppearanceChanged = false;
  public resourceLimited = false;
  readonly #scene: RuntimeSceneStateV1;
  readonly #revision: SceneRevision;
  readonly #elements = new Map<ElementId, ChangedElementV1>();
  readonly #groups = new Map<GroupId, ChangedGroupV1>();

  public constructor(
    scene: RuntimeSceneStateV1,
    dependencies: AnnotationDependencyIndexV1,
    revision: SceneRevision,
  ) {
    this.#scene = scene;
    this.#revision = revision;
    this.objectOrder = scene.objectOrder as PersistentSequenceV1<ElementId>;
    this.dependencies = dependencies;
    this.noteAppearance = scene.noteAppearance;
  }

  public element(elementId: ElementId): SceneElementV1 | undefined {
    if (this.#elements.has(elementId)) {
      return this.#elements.get(elementId) ?? undefined;
    }
    return this.#scene.elementsById.get(elementId);
  }

  public group(groupId: GroupId): GroupRecordV1 | undefined {
    if (this.#groups.has(groupId)) {
      return this.#groups.get(groupId) ?? undefined;
    }
    return this.#scene.groupsById.get(groupId);
  }

  public setElement(replacement: SceneElementV1 | null): boolean {
    const elementId = replacement?.elementId;
    if (elementId === undefined) return false;
    return this.replaceElement(elementId, replacement);
  }

  public deleteElement(elementId: ElementId): boolean {
    return this.replaceElement(elementId, null);
  }

  public setGroups(changes: readonly GroupReplacementV1[]): boolean {
    for (const change of changes) this.addAncestorGroups(change.groupId);
    const dependencies = replaceAnnotationGroupsV1(this.dependencies, changes);
    if (!dependencies.ok) {
      this.resourceLimited = dependencies.code === "resource-limit";
      return false;
    }
    this.dependencies = dependencies.value;
    for (const change of changes) {
      this.#groups.set(change.groupId, change.replacement);
      this.affectedGroupIds.add(change.groupId);
      this.addAncestorGroups(change.groupId);
    }
    return true;
  }

  public insertOrder(placement: OrderPlacementV1): boolean {
    const result = insertAnnotationOrderV1(this.dependencies, placement);
    if (!result.ok) return this.rejectOrder(result.code);
    this.applyOrderChange([placement], result.index, result.sequence);
    return true;
  }

  public deleteOrder(placement: OrderPlacementV1): boolean {
    const result = deleteAnnotationOrderV1(this.dependencies, placement);
    if (!result.ok) return this.rejectOrder(result.code);
    this.applyOrderChange([placement], result.index, result.sequence);
    return true;
  }

  public moveOrder(
    prior: OrderPlacementV1,
    replacement: OrderPlacementV1,
  ): boolean {
    const result = moveAnnotationOrderV1(this.dependencies, prior, replacement);
    if (!result.ok) return this.rejectOrder(result.code);
    this.applyOrderChange([prior, replacement], result.index, result.sequence);
    return true;
  }

  public publish(): {
    readonly scene: RuntimeSceneStateV1;
    readonly index: AnnotationDependencyIndexV1;
  } {
    return publishAnnotationSceneV1(
      this.dependencies,
      this.#revision,
      this.noteAppearance,
    );
  }

  private replaceElement(
    elementId: ElementId,
    replacement: ChangedElementV1,
  ): boolean {
    const prior = this.element(elementId) ?? null;
    const indexed = replaceAnnotationElementV1(
      this.dependencies,
      prior,
      replacement,
    );
    if (!indexed.ok) {
      this.resourceLimited = indexed.code === "resource-limit";
      return false;
    }
    this.dependencies = indexed.value;
    this.#elements.set(elementId, replacement);
    this.affectedElementIds.add(elementId);
    this.addAncestorGroups(elementId);
    return true;
  }

  private applyOrderChange(
    placements: readonly OrderPlacementV1[],
    index: AnnotationDependencyIndexV1,
    sequence: PersistentSequenceV1<ElementId>,
  ): void {
    for (const placement of placements) this.markPlacement(placement);
    this.dependencies = index;
    this.objectOrder = sequence;
    this.objectOrderChanged = true;
  }

  private markPlacement(placement: OrderPlacementV1): void {
    for (const elementId of placement.movedElementIds) {
      this.affectedElementIds.add(elementId);
      this.addAncestorGroups(elementId);
    }
    this.addCommonBoundaryGroups(
      placement.predecessorId,
      placement.successorId,
    );
  }

  private addCommonBoundaryGroups(
    predecessorId: ElementId | null,
    successorId: ElementId | null,
  ): void {
    if (predecessorId === null || successorId === null) return;
    const predecessorAncestors = new Set<GroupId>();
    this.visitAncestorGroups(predecessorId, (groupId) => {
      predecessorAncestors.add(groupId);
    });
    this.visitAncestorGroups(successorId, (groupId) => {
      if (predecessorAncestors.has(groupId)) this.affectedGroupIds.add(groupId);
    });
  }

  private addAncestorGroups(childId: ElementId | GroupId): void {
    this.visitAncestorGroups(childId, (groupId) => {
      this.affectedGroupIds.add(groupId);
    });
  }

  private visitAncestorGroups(
    childId: ElementId | GroupId,
    visit: (groupId: GroupId) => void,
  ): void {
    let parent = this.dependencies.parentOf(childId);
    let depth = 0;
    while (parent !== undefined && depth <= MAX_GROUP_DEPTH_V1) {
      visit(parent);
      parent = this.dependencies.parentOf(parent);
      depth += 1;
    }
  }

  private rejectOrder(code: "invalid-placement" | "resource-limit"): false {
    this.resourceLimited = code === "resource-limit";
    return false;
  }
}
