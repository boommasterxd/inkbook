import type {
  ElementId,
  GroupId,
  SceneElementV1,
  SceneRevision,
} from "../model";
import {
  createSceneRevision,
  parseElementId,
  validateSceneElementV1,
} from "../model";
import { validateSceneElementAfterStrokeValidationV1 } from "../model/geometry-validation";
import { closedRecord } from "../model/validation-support";
import type {
  GroupRecordV1,
  NoteAppearanceV1,
  SerializedSceneStateV1,
} from "../scene";
import { SCENE_RESOURCE_LIMITS_V1 } from "../scene/resource-limits";
import {
  createCanonicalJsonByteCounterV1,
  type CanonicalJsonByteCounterV1,
} from "./canonical-byte-counter";
import {
  validateGroupRecordV1,
  validateNoteAppearanceV1,
} from "./scene-record-validation";
import {
  createDeltaVarintValidationProcessorV1,
  type DeltaVarintValidationProcessorV1,
  type ValidatedDeltaVarintStrokeV1,
} from "./delta-varint";
import { validateElementAttachmentsV1 } from "./scene-attachment-validation";

type DataRecord = Record<string, unknown>;
const LAST_INDEX_OFFSET = 1;

interface ParsedSceneV1 {
  readonly revision: SceneRevision;
  readonly elements: readonly unknown[];
  readonly objectOrder: readonly unknown[];
  readonly groups: readonly unknown[];
  readonly noteAppearance: unknown;
}

type Phase =
  | "measure"
  | "admit-elements"
  | "elements"
  | "object-order"
  | "groups"
  | "group-relations"
  | "group-contiguity"
  | "attachments"
  | "appearance"
  | "publish"
  | "done";

export interface SerializedSceneValidationProcessorV1 {
  readonly done: boolean;
  processNext(): boolean;
  complete(): SerializedSceneStateV1 | undefined;
  dispose(): void;
}

export function createSerializedSceneValidationProcessorV1(
  value: unknown,
  measuredUtf8Bytes?: number,
): SerializedSceneValidationProcessorV1 {
  if (measuredUtf8Bytes !== undefined) assertBoundedBytes(measuredUtf8Bytes);
  return new SceneValidationProcessor(
    validateBoundary(value),
    measuredUtf8Bytes === undefined,
  );
}

class SceneValidationProcessor implements SerializedSceneValidationProcessorV1 {
  #phase: Phase;
  #index = 0;
  readonly #canonical: CanonicalJsonByteCounterV1 | null;
  #strokeDecoder: DeltaVarintValidationProcessorV1 | undefined;
  #admittedStrokePoints = 0;
  #validatedStrokePoints = 0;
  #elements: SceneElementV1[] = [];
  #objectOrder: ElementId[] = [];
  #groups: GroupRecordV1[] = [];
  #appearance: NoteAppearanceV1 | undefined;
  #elementIds = new Set<ElementId>();
  #groupIds = new Set<GroupId>();
  #orderIds = new Set<ElementId>();
  #parents = new Set<ElementId | GroupId>();
  #positions = new Map<ElementId, number>();
  #elementsById = new Map<ElementId, SceneElementV1>();
  #groupsById = new Map<GroupId, GroupRecordV1>();
  #flattened = new Map<GroupId, readonly ElementId[]>();
  #attachmentFanout = new Map<ElementId, number>();
  #result: SerializedSceneStateV1 | undefined;
  #disposed = false;

  constructor(
    private readonly source: ParsedSceneV1,
    measureCanonicalBytes: boolean,
  ) {
    this.#phase = measureCanonicalBytes ? "measure" : "admit-elements";
    this.#canonical = measureCanonicalBytes
      ? createCanonicalJsonByteCounterV1(
          source,
          SCENE_RESOURCE_LIMITS_V1.maxUtf8Bytes,
        )
      : null;
    const records = source.elements.length + source.groups.length;
    if (records > SCENE_RESOURCE_LIMITS_V1.maxRecords) {
      throw new RangeError("Scene record count exceeds the V1 limit.");
    }
  }

  get done(): boolean {
    return this.#phase === "done";
  }

  processNext(): boolean {
    this.assertUsable();
    switch (this.#phase) {
      case "measure":
        this.measureCanonicalChunk();
        break;
      case "admit-elements":
        this.admitElement();
        break;
      case "elements":
        this.validateElement();
        break;
      case "object-order":
        this.validateOrderId();
        break;
      case "groups":
        this.validateGroup();
        break;
      case "group-relations":
        this.validateGroupRelations();
        break;
      case "group-contiguity":
        this.validateGroupContiguity();
        break;
      case "attachments":
        this.validateElementAttachments();
        break;
      case "appearance":
        this.#appearance = validateNoteAppearanceV1(this.source.noteAppearance);
        this.advance("publish");
        break;
      case "publish":
        this.publish();
        break;
      case "done":
        return true;
    }
    return this.done;
  }

  complete(): SerializedSceneStateV1 | undefined {
    this.assertUsable();
    return this.#result;
  }

  dispose(): void {
    this.#disposed = true;
    this.#result = undefined;
    this.#elements = [];
    this.#objectOrder = [];
    this.#groups = [];
    this.#elementIds.clear();
    this.#groupIds.clear();
    this.#orderIds.clear();
    this.#parents.clear();
    this.#positions.clear();
    this.#elementsById.clear();
    this.#groupsById.clear();
    this.#flattened.clear();
    this.#attachmentFanout.clear();
    this.#strokeDecoder?.dispose();
    this.#strokeDecoder = undefined;
  }

  private admitElement(): void {
    if (this.#index >= this.source.elements.length) {
      this.advance("elements");
      return;
    }
    const candidate = this.source.elements[this.#index];
    const pointCount = readStrokePointCount(candidate);
    if (pointCount !== null) {
      this.#admittedStrokePoints += pointCount;
      if (
        this.#admittedStrokePoints > SCENE_RESOURCE_LIMITS_V1.maxStrokePoints
      ) {
        throw new RangeError("Aggregate stroke points exceed the V1 limit.");
      }
    }
    this.#index += 1;
  }

  private measureCanonicalChunk(): void {
    const canonical = this.#canonical;
    if (canonical === null) {
      throw new Error("Canonical scene measurement is unavailable.");
    }
    if (canonical.processNext()) this.advance("admit-elements");
  }

  private validateElement(): void {
    if (this.#index >= this.source.elements.length) {
      this.assertAggregateStable();
      this.advance("object-order");
      return;
    }
    const candidate = this.source.elements[this.#index];
    const validatedStroke = this.validateStroke(candidate);
    if (validatedStroke === null) return;
    const element =
      validatedStroke === undefined
        ? validateSceneElementV1(candidate)
        : validateSceneElementAfterStrokeValidationV1(
            candidate,
            validatedStroke,
          );
    this.#strokeDecoder?.dispose();
    this.#strokeDecoder = undefined;
    this.assertElementRevision(element);
    if (this.#elementIds.has(element.elementId)) {
      throw new TypeError("Element IDs must be unique.");
    }
    this.#elementIds.add(element.elementId);
    this.#elementsById.set(element.elementId, element);
    this.#elements.push(element);
    if (element.kind === "pen" || element.kind === "highlighter") {
      this.#validatedStrokePoints += element.geometry.stroke.pointCount;
    }
    this.#index += 1;
  }

  private validateStroke(
    candidate: unknown,
  ): ValidatedDeltaVarintStrokeV1 | undefined | null {
    const strokeCandidate = readStroke(candidate);
    if (strokeCandidate === null) return undefined;
    this.#strokeDecoder ??= createDeltaVarintValidationProcessorV1(
      strokeCandidate.stroke,
    );
    if (!this.#strokeDecoder.processNext()) return null;
    const validation = this.#strokeDecoder.complete();
    if (validation === undefined) {
      throw new Error("Stroke validation completed without a result.");
    }
    return validation;
  }

  private validateOrderId(): void {
    if (
      this.#index === 0 &&
      this.source.objectOrder.length !== this.source.elements.length
    ) {
      throw new TypeError("Object order must contain every scene element.");
    }
    if (this.#index >= this.source.objectOrder.length) {
      this.advance("groups");
      return;
    }
    const value = this.source.objectOrder[this.#index];
    if (typeof value !== "string") {
      throw new TypeError("Object order IDs must be strings.");
    }
    const elementId = parseElementId(value);
    if (this.#orderIds.has(elementId) || !this.#elementIds.has(elementId)) {
      throw new TypeError(
        "Object order must be a complete duplicate-free permutation.",
      );
    }
    if (this.#elements[this.#index]?.elementId !== elementId) {
      throw new TypeError(
        "Element array order must exactly equal object order.",
      );
    }
    this.#orderIds.add(elementId);
    this.#positions.set(elementId, this.#index);
    this.#objectOrder.push(elementId);
    this.#index += 1;
  }

  private validateGroup(): void {
    if (this.#index >= this.source.groups.length) {
      this.advance("group-relations");
      return;
    }
    const candidate = this.source.groups[this.#index];
    const group = validateGroupRecordV1(candidate);
    const previous = this.#groups[this.#groups.length - LAST_INDEX_OFFSET];
    if (previous !== undefined && previous.groupId >= group.groupId) {
      throw new TypeError(
        "Groups must use ascending canonical group ID order.",
      );
    }
    if (this.#groupIds.has(group.groupId)) {
      throw new TypeError("Group IDs must be unique.");
    }
    this.#groupIds.add(group.groupId);
    this.#groupsById.set(group.groupId, group);
    this.#groups.push(group);
    this.#index += 1;
  }

  private validateGroupRelations(): void {
    const group = this.#groups[this.#index];
    if (group === undefined) {
      this.advance("group-contiguity");
      return;
    }
    const direct = new Set<ElementId | GroupId>();
    for (const child of group.childIds) {
      const resolves = child.startsWith("el_")
        ? this.#elementIds.has(child as ElementId)
        : this.#groupIds.has(child as GroupId);
      if (!resolves) {
        throw new TypeError("Group child reference does not resolve.");
      }
      if (direct.has(child) || this.#parents.has(child)) {
        throw new TypeError("A group child may have only one direct parent.");
      }
      direct.add(child);
      this.#parents.add(child);
    }
    this.#index += 1;
  }

  private validateGroupContiguity(): void {
    const group = this.#groups[this.#index];
    if (group === undefined) {
      this.advance("attachments");
      return;
    }
    const leaves = this.flattenGroup(group, new Set(), 1);
    const first = leaves[0];
    if (first === undefined)
      throw new TypeError("A group must contain leaves.");
    const start = this.#positions.get(first);
    if (start === undefined) {
      throw new TypeError("Group leaf does not resolve in object order.");
    }
    for (let index = 0; index < leaves.length; index += 1) {
      const leaf = leaves[index];
      if (leaf === undefined || this.#positions.get(leaf) !== start + index) {
        throw new TypeError(
          "Group leaves must equal one contiguous object-order subsequence.",
        );
      }
    }
    this.#index += 1;
  }

  private flattenGroup(
    group: GroupRecordV1,
    active: ReadonlySet<GroupId>,
    depth: number,
  ): readonly ElementId[] {
    const existing = this.#flattened.get(group.groupId);
    if (existing !== undefined) return existing;
    if (active.has(group.groupId)) {
      throw new TypeError("Group topology must be acyclic.");
    }
    if (depth > SCENE_RESOURCE_LIMITS_V1.maxGroupNesting) {
      throw new RangeError("Group nesting exceeds the V1 limit.");
    }
    const next = new Set(active).add(group.groupId);
    const leaves: ElementId[] = [];
    for (const child of group.childIds) {
      if (child.startsWith("el_")) leaves.push(child as ElementId);
      else {
        const nested = this.#groupsById.get(child as GroupId);
        if (nested === undefined) {
          throw new TypeError("Nested group does not resolve.");
        }
        leaves.push(...this.flattenGroup(nested, next, depth + 1));
      }
    }
    const frozen = Object.freeze(leaves);
    this.#flattened.set(group.groupId, frozen);
    return frozen;
  }

  private validateElementAttachments(): void {
    const element = this.#elements[this.#index];
    if (element === undefined) {
      this.advance("appearance");
      return;
    }
    validateElementAttachmentsV1(
      element,
      this.#elementsById,
      this.#attachmentFanout,
    );
    this.#index += 1;
  }

  private assertAggregateStable(): void {
    if (this.#validatedStrokePoints !== this.#admittedStrokePoints) {
      throw new TypeError(
        "Validated scene aggregates changed after admission.",
      );
    }
  }

  private assertElementRevision(element: SceneElementV1): void {
    if (
      element.geometryRevision > this.source.revision ||
      element.styleRevision > this.source.revision ||
      element.bindingRevision > this.source.revision
    ) {
      throw new RangeError("Component revisions cannot exceed scene revision.");
    }
  }

  private publish(): void {
    if (this.#appearance === undefined) {
      throw new Error("Scene appearance validation is incomplete.");
    }
    this.#result = Object.freeze({
      revision: this.source.revision,
      elements: Object.freeze(this.#elements),
      objectOrder: Object.freeze(this.#objectOrder),
      groups: Object.freeze(this.#groups),
      noteAppearance: this.#appearance,
    });
    this.#phase = "done";
  }

  private advance(phase: Phase): void {
    this.#phase = phase;
    this.#index = 0;
  }

  private assertUsable(): void {
    if (this.#disposed) throw new Error("Scene validation is disposed.");
  }
}

function validateBoundary(value: unknown): ParsedSceneV1 {
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

function assertArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array.`);
  return value;
}

function assertBoundedBytes(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > SCENE_RESOURCE_LIMITS_V1.maxUtf8Bytes
  ) {
    throw new RangeError("Parsed scene exceeds the V1 UTF-8 limit.");
  }
}

function readStrokePointCount(candidate: unknown): number | null {
  if (candidate === null || typeof candidate !== "object") return null;
  const element = candidate as DataRecord;
  if (element.kind !== "pen" && element.kind !== "highlighter") return null;
  const geometry = element.geometry as DataRecord | undefined;
  const stroke = geometry?.stroke as DataRecord | undefined;
  return Number.isSafeInteger(stroke?.pointCount) &&
    (stroke?.pointCount as number) >= 0
    ? (stroke?.pointCount as number)
    : null;
}

function readStroke(candidate: unknown): { readonly stroke: unknown } | null {
  if (candidate === null || typeof candidate !== "object") return null;
  const element = candidate as DataRecord;
  if (element.kind !== "pen" && element.kind !== "highlighter") return null;
  const geometry = element.geometry as DataRecord | undefined;
  const stroke = geometry?.stroke as DataRecord | undefined;
  return stroke === undefined ? null : { stroke };
}
