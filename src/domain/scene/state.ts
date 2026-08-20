import type {
  ElementId,
  GroupId,
  SceneElementV1,
  SceneRevision,
} from "../model";
import { materializeSceneElementV1 } from "../model";
import type { PathCopyStatsV1, PersistentMapViewV1 } from "./persistent-map";
import { PersistentMapV1 } from "./persistent-map";
import type { PersistentSequenceViewV1 } from "./persistent-sequence";
import { PersistentSequenceV1 } from "./persistent-sequence";

export interface GroupRecordV1 {
  readonly groupId: GroupId;
  readonly childIds: readonly (ElementId | GroupId)[];
  readonly selectionRotationRadians: number;
}

export interface NoteAppearanceV1 {
  readonly background: "none" | "ruled" | "squared" | "dotted";
  readonly horizontalSpacing: "compact" | "standard" | "wide";
  readonly contrast: "low" | "medium" | "high";
}

export interface SerializedSceneStateV1 {
  readonly revision: SceneRevision;
  readonly elements: readonly SceneElementV1[];
  readonly objectOrder: readonly ElementId[];
  readonly groups: readonly GroupRecordV1[];
  readonly noteAppearance: NoteAppearanceV1;
}

export interface RuntimeSceneStateV1 {
  readonly revision: SceneRevision;
  readonly elementsById: PersistentMapViewV1<ElementId, SceneElementV1>;
  readonly objectOrder: PersistentSequenceViewV1<ElementId>;
  readonly groupsById: PersistentMapViewV1<GroupId, GroupRecordV1>;
  readonly noteAppearance: NoteAppearanceV1;
}

export interface RuntimeSceneSourceV1 {
  readonly revision: SceneRevision;
  readonly elements: Iterable<SceneElementV1>;
  readonly objectOrder: Iterable<ElementId>;
  readonly groups: Iterable<GroupRecordV1>;
  readonly noteAppearance: NoteAppearanceV1;
}

export interface RuntimeSceneChangesV1 {
  readonly revision: SceneRevision;
  readonly elements?: Iterable<readonly [ElementId, SceneElementV1 | null]>;
  readonly groups?: Iterable<readonly [GroupId, GroupRecordV1 | null]>;
  readonly objectOrder?: PersistentSequenceV1<ElementId>;
  readonly noteAppearance?: NoteAppearanceV1;
}

interface RuntimeSceneUpdateStatsV1 {
  readonly elementStore: PathCopyStatsV1;
  readonly groupStore: PathCopyStatsV1;
  readonly affectedElementIds: readonly ElementId[];
  readonly affectedGroupIds: readonly GroupId[];
}

export interface RuntimeSceneUpdateV1 {
  readonly scene: RuntimeSceneStateV1;
  readonly stats: RuntimeSceneUpdateStatsV1;
}

const EMPTY_STATS: PathCopyStatsV1 = Object.freeze({
  visitedNodes: 0,
  allocatedNodes: 0,
});

export function materializeGroupRecordV1(group: GroupRecordV1): GroupRecordV1 {
  return Object.freeze({
    ...group,
    childIds: Object.freeze([...group.childIds]),
  });
}

export function materializeNoteAppearanceV1(
  appearance: NoteAppearanceV1,
): NoteAppearanceV1 {
  return Object.freeze({ ...appearance });
}

function createElements(
  source: Iterable<SceneElementV1>,
): PersistentMapV1<ElementId, SceneElementV1> {
  let elements = PersistentMapV1.empty<ElementId, SceneElementV1>();
  for (const candidate of source) {
    if (elements.has(candidate.elementId)) {
      throw new TypeError(
        "A runtime scene cannot contain duplicate element IDs.",
      );
    }
    const element = materializeSceneElementV1(candidate);
    elements = elements.set(element.elementId, element);
  }
  return elements;
}

function createGroups(
  source: Iterable<GroupRecordV1>,
): PersistentMapV1<GroupId, GroupRecordV1> {
  let groups = PersistentMapV1.empty<GroupId, GroupRecordV1>();
  for (const candidate of source) {
    if (groups.has(candidate.groupId)) {
      throw new TypeError(
        "A runtime scene cannot contain duplicate group IDs.",
      );
    }
    const group = materializeGroupRecordV1(candidate);
    groups = groups.set(group.groupId, group);
  }
  return groups;
}

export function createRuntimeSceneStateV1(
  source: RuntimeSceneSourceV1,
): RuntimeSceneStateV1 {
  return Object.freeze({
    revision: source.revision,
    elementsById: createElements(source.elements),
    objectOrder: PersistentSequenceV1.fromIterable(source.objectOrder),
    groupsById: createGroups(source.groups),
    noteAppearance: materializeNoteAppearanceV1(source.noteAppearance),
  });
}

function updateElements(
  current: PersistentMapViewV1<ElementId, SceneElementV1>,
  changes: RuntimeSceneChangesV1["elements"],
): readonly [
  PersistentMapV1<ElementId, SceneElementV1>,
  PathCopyStatsV1,
  readonly ElementId[],
] {
  let elements = current as PersistentMapV1<ElementId, SceneElementV1>;
  let visitedNodes = 0;
  let allocatedNodes = 0;
  const affected: ElementId[] = [];
  for (const [elementId, replacement] of changes ?? []) {
    if (replacement !== null && replacement.elementId !== elementId) {
      throw new TypeError("An element replacement must retain its map key.");
    }
    const update =
      replacement === null
        ? elements.deleteWithStats(elementId)
        : elements.setWithStats(
            elementId,
            materializeSceneElementV1(replacement),
          );
    elements = update.map;
    visitedNodes += update.stats.visitedNodes;
    allocatedNodes += update.stats.allocatedNodes;
    affected.push(elementId);
  }
  return Object.freeze([
    elements,
    Object.freeze({ visitedNodes, allocatedNodes }),
    Object.freeze(affected),
  ]);
}

function updateGroups(
  current: PersistentMapViewV1<GroupId, GroupRecordV1>,
  changes: RuntimeSceneChangesV1["groups"],
): readonly [
  PersistentMapV1<GroupId, GroupRecordV1>,
  PathCopyStatsV1,
  readonly GroupId[],
] {
  let groups = current as PersistentMapV1<GroupId, GroupRecordV1>;
  let visitedNodes = 0;
  let allocatedNodes = 0;
  const affected: GroupId[] = [];
  for (const [groupId, replacement] of changes ?? []) {
    if (replacement !== null && replacement.groupId !== groupId) {
      throw new TypeError("A Group replacement must retain its map key.");
    }
    const update =
      replacement === null
        ? groups.deleteWithStats(groupId)
        : groups.setWithStats(groupId, materializeGroupRecordV1(replacement));
    groups = update.map;
    visitedNodes += update.stats.visitedNodes;
    allocatedNodes += update.stats.allocatedNodes;
    affected.push(groupId);
  }
  return Object.freeze([
    groups,
    Object.freeze({ visitedNodes, allocatedNodes }),
    Object.freeze(affected),
  ]);
}

export function updateRuntimeSceneStateV1(
  current: RuntimeSceneStateV1,
  changes: RuntimeSceneChangesV1,
): RuntimeSceneUpdateV1 {
  const [elementsById, elementStore, affectedElementIds] = updateElements(
    current.elementsById,
    changes.elements,
  );
  const [groupsById, groupStore, affectedGroupIds] = updateGroups(
    current.groupsById,
    changes.groups,
  );
  const scene = Object.freeze({
    revision: changes.revision,
    elementsById,
    objectOrder: changes.objectOrder ?? current.objectOrder,
    groupsById,
    noteAppearance:
      changes.noteAppearance === undefined
        ? current.noteAppearance
        : materializeNoteAppearanceV1(changes.noteAppearance),
  });
  return Object.freeze({
    scene,
    stats: Object.freeze({
      elementStore: changes.elements === undefined ? EMPTY_STATS : elementStore,
      groupStore: changes.groups === undefined ? EMPTY_STATS : groupStore,
      affectedElementIds,
      affectedGroupIds,
    }),
  });
}

export function materializeSerializedSceneStateV1(
  runtime: RuntimeSceneStateV1,
): SerializedSceneStateV1 {
  const elements: SceneElementV1[] = [];
  for (let index = 0; index < runtime.objectOrder.length; index += 1) {
    const elementId = runtime.objectOrder.get(index);
    const element =
      elementId === undefined ? undefined : runtime.elementsById.get(elementId);
    if (element === undefined) {
      throw new TypeError("Object order references a missing scene element.");
    }
    elements.push(element);
  }
  const groups = [...runtime.groupsById.entriesByCanonicalKey()].map(
    ([, group]) => group,
  );
  return Object.freeze({
    revision: runtime.revision,
    elements: Object.freeze(elements),
    objectOrder: Object.freeze(elements.map(({ elementId }) => elementId)),
    groups: Object.freeze(groups),
    noteAppearance: runtime.noteAppearance,
  });
}
