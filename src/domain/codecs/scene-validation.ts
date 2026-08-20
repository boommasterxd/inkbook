import type {
  ElementId,
  GroupId,
  ObjectPortIdV1,
  SceneElementV1,
  SceneRevision,
} from "../model";
import {
  createSceneRevision,
  parseElementId,
  parseGroupId,
  validateSceneElementV1,
} from "../model";
import type {
  GroupRecordV1,
  NoteAppearanceV1,
  RuntimeSceneStateV1,
} from "../scene";
import {
  createRuntimeSceneStateV1,
  materializeGroupRecordV1,
  materializeNoteAppearanceV1,
} from "../scene";
import { SCENE_RESOURCE_LIMITS_V1 } from "../scene/resource-limits";
import {
  canonicalRotation,
  closedRecord,
  closedValue,
} from "../model/validation-support";
import { encodeCanonicalJson } from "./canonical-json";
import {
  admitSceneRecordCount,
  admitSceneStrokePoints,
  confirmSceneAggregate,
} from "./scene-admission";

export { SCENE_RESOURCE_LIMITS_V1 } from "../scene/resource-limits";

type DataRecord = Record<string, unknown>;
const MIN_GROUP_CHILDREN = Number("2");

interface ParsedSceneV1 {
  readonly revision: SceneRevision;
  readonly elements: readonly unknown[];
  readonly objectOrder: readonly unknown[];
  readonly groups: readonly unknown[];
  readonly noteAppearance: unknown;
}

interface ValidatedIdsV1 {
  readonly elementIds: ReadonlySet<ElementId>;
  readonly groupIds: ReadonlySet<GroupId>;
}

function assertArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array.`);
  return value;
}

function dataRecord(value: unknown, name: string): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a data object.`);
  }
  return value as DataRecord;
}

function assertEncodedSceneSize(value: unknown): void {
  const bytes = encodeCanonicalJson(value);
  if (bytes.byteLength > SCENE_RESOURCE_LIMITS_V1.maxUtf8Bytes) {
    throw new RangeError("Serialized scene exceeds the V1 UTF-8 limit.");
  }
}

function assertBoundedSceneBytes(measuredUtf8Bytes: number): void {
  if (
    !Number.isSafeInteger(measuredUtf8Bytes) ||
    measuredUtf8Bytes < 0 ||
    measuredUtf8Bytes > SCENE_RESOURCE_LIMITS_V1.maxUtf8Bytes
  ) {
    throw new RangeError("Parsed scene exceeds the V1 UTF-8 limit.");
  }
}

function validateParsedBoundary(value: unknown): ParsedSceneV1 {
  const data = closedRecord(
    value,
    ["elements", "groups", "noteAppearance", "objectOrder", "revision"],
    "Serialized scene",
  );
  return Object.freeze({
    revision: createSceneRevision(data.revision as number),
    elements: assertArray(data.elements, "Scene elements"),
    objectOrder: assertArray(data.objectOrder, "Object order"),
    groups: assertArray(data.groups, "Scene groups"),
    noteAppearance: data.noteAppearance,
  });
}

function validateClosedDiscriminators(scene: ParsedSceneV1): void {
  const kinds = [
    "pen",
    "highlighter",
    "rectangle",
    "ellipse",
    "triangle",
    "diamond",
    "octagon",
    "line",
    "arrow",
    "table",
    "axes-2d",
    "axes-3d",
  ] as const;
  for (const candidate of scene.elements) {
    const element = dataRecord(candidate, "Element");
    closedValue(element.kind, kinds, "Element kind");
    const binding = dataRecord(element.binding, "Element binding");
    const bindingKind = closedValue(
      binding.kind,
      ["text-range", "text-position", "fixed"],
      "Binding kind",
    );
    if (bindingKind === "text-range") {
      closedValue(
        binding.presentation,
        ["highlight", "underline", "enclosure"],
        "Range presentation",
      );
    }
    closedValue(binding.origin, ["inferred", "manual"], "Binding origin");
    closedValue(
      binding.confidence,
      ["high", "medium", "low"],
      "Binding confidence",
    );
  }
  const appearance = dataRecord(scene.noteAppearance, "Note appearance");
  closedValue(
    appearance.background,
    ["none", "ruled", "squared", "dotted"],
    "Note background",
  );
  closedValue(
    appearance.horizontalSpacing,
    ["compact", "standard", "wide"],
    "Note spacing",
  );
  closedValue(appearance.contrast, ["low", "medium", "high"], "Note contrast");
}

function validateUniqueIds(scene: ParsedSceneV1): ValidatedIdsV1 {
  const elementIds = new Set<ElementId>();
  for (const candidate of scene.elements) {
    const raw = (candidate as DataRecord).elementId;
    if (typeof raw !== "string")
      throw new TypeError("Element ID must be a string.");
    const elementId = parseElementId(raw);
    if (elementIds.has(elementId))
      throw new TypeError("Element IDs must be unique.");
    elementIds.add(elementId);
  }
  const groupIds = new Set<GroupId>();
  for (const candidate of scene.groups) {
    const raw = (candidate as DataRecord).groupId;
    if (typeof raw !== "string")
      throw new TypeError("Group ID must be a string.");
    const groupId = parseGroupId(raw);
    if (groupIds.has(groupId)) throw new TypeError("Group IDs must be unique.");
    groupIds.add(groupId);
  }
  return Object.freeze({ elementIds, groupIds });
}

function validateElements(scene: ParsedSceneV1): readonly SceneElementV1[] {
  return Object.freeze(
    scene.elements.map((value) => {
      const element = validateSceneElementV1(value);
      if (
        element.geometryRevision > scene.revision ||
        element.styleRevision > scene.revision ||
        element.bindingRevision > scene.revision
      ) {
        throw new RangeError(
          "Component revisions cannot exceed scene revision.",
        );
      }
      return element;
    }),
  );
}

function validateObjectOrder(
  scene: ParsedSceneV1,
  elements: readonly SceneElementV1[],
  elementIds: ReadonlySet<ElementId>,
): readonly ElementId[] {
  if (scene.objectOrder.length !== elements.length) {
    throw new TypeError("Object order must contain every scene element.");
  }
  const seen = new Set<ElementId>();
  const order = scene.objectOrder.map((value, index) => {
    if (typeof value !== "string")
      throw new TypeError("Object order IDs must be strings.");
    const elementId = parseElementId(value);
    if (!elementIds.has(elementId) || seen.has(elementId)) {
      throw new TypeError(
        "Object order must be a complete duplicate-free permutation.",
      );
    }
    if (elements[index]?.elementId !== elementId) {
      throw new TypeError(
        "Element array order must exactly equal object order.",
      );
    }
    seen.add(elementId);
    return elementId;
  });
  return Object.freeze(order);
}

export function validateGroupRecordV1(value: unknown): GroupRecordV1 {
  const data = closedRecord(
    value,
    ["childIds", "groupId", "selectionRotationRadians"],
    "Group",
  );
  if (typeof data.groupId !== "string")
    throw new TypeError("Group ID must be a string.");
  data.groupId = parseGroupId(data.groupId);
  const children = assertArray(data.childIds, "Group children");
  if (children.length < MIN_GROUP_CHILDREN)
    throw new RangeError("A group requires at least two direct children.");
  data.childIds = Object.freeze(
    children.map((child) => {
      if (typeof child !== "string")
        throw new TypeError("Group child IDs must be strings.");
      return child.startsWith("el_")
        ? parseElementId(child)
        : parseGroupId(child);
    }),
  );
  canonicalRotation(data.selectionRotationRadians, "Group selection rotation");
  return materializeGroupRecordV1(data as unknown as GroupRecordV1);
}

function validateGroups(
  scene: ParsedSceneV1,
  ids: ValidatedIdsV1,
  objectOrder: readonly ElementId[],
): readonly GroupRecordV1[] {
  const groups = scene.groups.map((value) => validateGroupRecordV1(value));
  for (let index = 1; index < groups.length; index += 1) {
    if ((groups[index - 1]?.groupId ?? "") >= (groups[index]?.groupId ?? "")) {
      throw new TypeError(
        "Groups must use ascending canonical group ID order.",
      );
    }
  }
  const byId = new Map(groups.map((group) => [group.groupId, group]));
  validateGroupRelationships(groups, byId, ids);
  const flattened = new Map<GroupId, readonly ElementId[]>();
  const positions = new Map(
    objectOrder.map((elementId, index) => [elementId, index]),
  );
  for (const group of groups) {
    const leaves = flattenGroup(group, byId, flattened, new Set(), 1);
    assertContiguousLeaves(leaves, positions);
  }
  return Object.freeze(groups);
}

function validateGroupRelationships(
  groups: readonly GroupRecordV1[],
  byId: ReadonlyMap<GroupId, GroupRecordV1>,
  ids: ValidatedIdsV1,
): void {
  const parents = new Set<ElementId | GroupId>();
  for (const group of groups) {
    const direct = new Set<ElementId | GroupId>();
    for (const child of group.childIds) {
      const resolves = child.startsWith("el_")
        ? ids.elementIds.has(child as ElementId)
        : byId.has(child as GroupId);
      if (!resolves)
        throw new TypeError("Group child reference does not resolve.");
      if (direct.has(child) || parents.has(child)) {
        throw new TypeError("A group child may have only one direct parent.");
      }
      direct.add(child);
      parents.add(child);
    }
  }
}

function flattenGroup(
  group: GroupRecordV1,
  groups: ReadonlyMap<GroupId, GroupRecordV1>,
  cache: Map<GroupId, readonly ElementId[]>,
  active: ReadonlySet<GroupId>,
  depth: number,
): readonly ElementId[] {
  const existing = cache.get(group.groupId);
  if (existing !== undefined) return existing;
  if (active.has(group.groupId))
    throw new TypeError("Group topology must be acyclic.");
  if (depth > SCENE_RESOURCE_LIMITS_V1.maxGroupNesting) {
    throw new RangeError("Group nesting exceeds the V1 limit.");
  }
  const next = new Set(active).add(group.groupId);
  const leaves: ElementId[] = [];
  for (const child of group.childIds) {
    if (child.startsWith("el_")) leaves.push(child as ElementId);
    else {
      const nested = groups.get(child as GroupId);
      if (nested === undefined)
        throw new TypeError("Nested group does not resolve.");
      for (const leaf of flattenGroup(nested, groups, cache, next, depth + 1)) {
        leaves.push(leaf);
      }
    }
  }
  const frozen = Object.freeze(leaves);
  cache.set(group.groupId, frozen);
  return frozen;
}

function assertContiguousLeaves(
  leaves: readonly ElementId[],
  positions: ReadonlyMap<ElementId, number>,
): void {
  const first = leaves[0];
  if (first === undefined) throw new TypeError("A group must contain leaves.");
  const start = positions.get(first);
  if (start === undefined)
    throw new TypeError("Group leaf does not resolve in object order.");
  for (let index = 0; index < leaves.length; index += 1) {
    const leaf = leaves[index];
    if (leaf === undefined || positions.get(leaf) !== start + index) {
      throw new TypeError(
        "Group leaves must equal one contiguous object-order subsequence.",
      );
    }
  }
}

function acceptsAreaPort(target: SceneElementV1): boolean {
  switch (target.kind) {
    case "rectangle":
    case "ellipse":
    case "triangle":
    case "diamond":
    case "octagon":
    case "table":
      return true;
    default:
      return false;
  }
}

function isValidPort(target: SceneElementV1, portId: ObjectPortIdV1): boolean {
  switch (portId) {
    case "area:north":
    case "area:east":
    case "area:south":
    case "area:west":
      return acceptsAreaPort(target);
    case "axes:origin":
    case "axes:x-positive":
    case "axes:y-positive":
      return target.kind === "axes-2d" || target.kind === "axes-3d";
    case "axes:z-positive":
      return target.kind === "axes-3d";
  }
}

function validateAttachments(elements: readonly SceneElementV1[]): void {
  const byId = new Map(elements.map((element) => [element.elementId, element]));
  const fanout = new Map<ElementId, number>();
  for (const element of elements) {
    if (element.kind !== "line" && element.kind !== "arrow") continue;
    for (const endpoint of [element.geometry.start, element.geometry.end]) {
      const attachment = endpoint.attachment;
      if (attachment === null) continue;
      const target = byId.get(attachment.targetElementId);
      if (target === undefined || !isValidPort(target, attachment.portId)) {
        throw new TypeError("Endpoint attachment target or port is invalid.");
      }
      const count = (fanout.get(target.elementId) ?? 0) + 1;
      if (count > SCENE_RESOURCE_LIMITS_V1.maxAttachedEndpointsPerTarget) {
        throw new RangeError("Attachment fanout exceeds the V1 limit.");
      }
      fanout.set(target.elementId, count);
    }
  }
}

export function validateNoteAppearanceV1(value: unknown): NoteAppearanceV1 {
  const data = closedRecord(
    value,
    ["background", "contrast", "horizontalSpacing"],
    "Note appearance",
  );
  closedValue(
    data.background,
    ["none", "ruled", "squared", "dotted"],
    "Note background",
  );
  closedValue(
    data.horizontalSpacing,
    ["compact", "standard", "wide"],
    "Note spacing",
  );
  closedValue(data.contrast, ["low", "medium", "high"], "Note contrast");
  return materializeNoteAppearanceV1(data as unknown as NoteAppearanceV1);
}

export function validateSerializedSceneStateV1(
  value: unknown,
): RuntimeSceneStateV1 {
  assertEncodedSceneSize(value);
  return constructRuntimeSceneStateV1(value);
}

export function validateBoundedSerializedSceneStateV1(
  value: unknown,
  measuredUtf8Bytes: number,
): RuntimeSceneStateV1 {
  assertBoundedSceneBytes(measuredUtf8Bytes);
  return constructRuntimeSceneStateV1(value);
}

function constructRuntimeSceneStateV1(value: unknown): RuntimeSceneStateV1 {
  const scene = validateParsedBoundary(value);
  const records = admitSceneRecordCount(scene.elements, scene.groups);
  validateClosedDiscriminators(scene);
  const ids = validateUniqueIds(scene);
  const admittedAggregate = admitSceneStrokePoints(scene.elements, records);
  const elements = validateElements(scene);
  const objectOrder = validateObjectOrder(scene, elements, ids.elementIds);
  const groups = validateGroups(scene, ids, objectOrder);
  validateAttachments(elements);
  confirmSceneAggregate(elements, groups, admittedAggregate);
  return createRuntimeSceneStateV1({
    revision: scene.revision,
    elements,
    objectOrder,
    groups,
    noteAppearance: validateNoteAppearanceV1(scene.noteAppearance),
  });
}
