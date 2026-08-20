import {
  parseElementId,
  parseGroupId,
  validateCanonicalStyleV1,
  validateElementBindingV1,
  validateLinearGeometryV1,
  validateNonLinearGeometryV1,
  validateSceneElementValueV1,
  type CanonicalStyleV1,
  type ElementBinding,
  type ElementId,
  type GroupId,
  type LinearGeometryV1,
  type NonLinearGeometryV1,
  type SceneElementValueV1,
} from "../model/index";
import type { GroupRecordV1, NoteAppearanceV1 } from "../scene/index";
import {
  materializeGroupRecordV1,
  materializeNoteAppearanceV1,
} from "../scene/index";
import type {
  AnnotationPatchResultV1,
  AnnotationPatchV1,
  BatchMemberV1,
  ComponentReplacementV1,
  GroupReplacementV1,
  OrderPlacementV1,
} from "./types";
import { canonicalValueEqualsV1, hasExactKeysV1 } from "./value-equality";

const MAX_PATCH_ITEMS_V1 = 100_000;
const MIN_GROUP_CHILDREN_V1 = 2;

type DataRecord = Readonly<Record<string, unknown>>;

interface ValidationBudgetV1 {
  remaining: number;
}

function dataDiscriminator(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
  return (prototype === Object.prototype || prototype === null) &&
    descriptor?.enumerable === true &&
    "value" in descriptor
    ? descriptor.value
    : undefined;
}

function consume(budget: ValidationBudgetV1, count: number): void {
  if (count <= 0) throw new TypeError("A patch collection must be non-empty.");
  budget.remaining -= count;
  if (budget.remaining < 0)
    throw new RangeError("Patch exceeds its V1 item limit.");
}

function parseId<T>(value: unknown, parser: (candidate: string) => T): T {
  if (typeof value !== "string") throw new TypeError("An ID must be a string.");
  return parser(value);
}

function elementId(value: unknown): ElementId {
  return parseId(value, parseElementId);
}

function groupId(value: unknown): GroupId {
  return parseId(value, parseGroupId);
}

function dataRecord(value: unknown, keys: readonly string[]): DataRecord {
  if (!hasExactKeysV1(value, keys))
    throw new TypeError("Invalid closed V1 record.");
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("A patch record must be a plain data object.");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      throw new TypeError(
        "A patch record may contain only enumerable data fields.",
      );
    }
  }
  return value;
}

function distinctElementIds(values: readonly ElementId[]): boolean {
  return new Set(values).size === values.length;
}

function placement(
  value: unknown,
  budget: ValidationBudgetV1,
): OrderPlacementV1 {
  const data = dataRecord(value, [
    "movedElementIds",
    "predecessorId",
    "successorId",
  ]);
  if (!Array.isArray(data.movedElementIds))
    throw new TypeError("Invalid moved IDs.");
  consume(budget, data.movedElementIds.length);
  const movedElementIds = Object.freeze(data.movedElementIds.map(elementId));
  if (!distinctElementIds(movedElementIds))
    throw new TypeError("Duplicate moved ID.");
  const predecessorId =
    data.predecessorId === null ? null : elementId(data.predecessorId);
  const successorId =
    data.successorId === null ? null : elementId(data.successorId);
  if (
    (predecessorId !== null && movedElementIds.includes(predecessorId)) ||
    (successorId !== null && movedElementIds.includes(successorId))
  ) {
    throw new TypeError("Placement anchors cannot be moved members.");
  }
  return Object.freeze({ movedElementIds, predecessorId, successorId });
}

function elementValues(
  value: unknown,
  budget: ValidationBudgetV1,
): readonly SceneElementValueV1[] {
  if (!Array.isArray(value)) throw new TypeError("Invalid element collection.");
  consume(budget, value.length);
  const elements = Object.freeze(value.map(validateSceneElementValueV1));
  if (!distinctElementIds(elements.map(({ elementId: id }) => id))) {
    throw new TypeError("Duplicate element change.");
  }
  return elements;
}

function validateAnyNonLinearGeometry(value: unknown): NonLinearGeometryV1 {
  const kinds = ["pen", "rectangle", "table", "axes-2d", "axes-3d"] as const;
  for (const kind of kinds) {
    try {
      return validateNonLinearGeometryV1(value, kind);
    } catch (error) {
      if (!(error instanceof TypeError || error instanceof RangeError))
        throw error;
    }
  }
  throw new TypeError("Invalid non-linear geometry.");
}

function validateAnyStyle(value: unknown): CanonicalStyleV1 {
  const kinds = ["pen", "highlighter", "rectangle", "line", "table"] as const;
  for (const kind of kinds) {
    try {
      return validateCanonicalStyleV1(value, kind);
    } catch (error) {
      if (!(error instanceof TypeError || error instanceof RangeError))
        throw error;
    }
  }
  throw new TypeError("Invalid canonical style.");
}

function replacements<T>(
  value: unknown,
  budget: ValidationBudgetV1,
  validate: (candidate: unknown) => T,
): readonly ComponentReplacementV1<T>[] {
  if (!Array.isArray(value))
    throw new TypeError("Invalid replacement collection.");
  consume(budget, value.length);
  const seen = new Set<ElementId>();
  return Object.freeze(
    value.map((candidate) => {
      const data = dataRecord(candidate, ["elementId", "prior", "replacement"]);
      const id = elementId(data.elementId);
      if (seen.has(id)) throw new TypeError("Duplicate component replacement.");
      seen.add(id);
      const prior = validate(data.prior);
      const replacement = validate(data.replacement);
      if (canonicalValueEqualsV1(prior, replacement)) {
        throw new TypeError("A component replacement must change its value.");
      }
      return Object.freeze({ elementId: id, prior, replacement });
    }),
  );
}

function groupRecord(
  value: unknown,
  expectedId: GroupId,
  budget: ValidationBudgetV1,
): GroupRecordV1 {
  const data = dataRecord(value, [
    "childIds",
    "groupId",
    "selectionRotationRadians",
  ]);
  const id = groupId(data.groupId);
  if (id !== expectedId || !Array.isArray(data.childIds)) {
    throw new TypeError("Invalid Group replacement identity.");
  }
  if (
    data.childIds.length < MIN_GROUP_CHILDREN_V1 ||
    data.childIds.length > MAX_PATCH_ITEMS_V1
  ) {
    throw new RangeError("Group child count is outside its V1 range.");
  }
  consume(budget, data.childIds.length);
  const childIds = Object.freeze(
    data.childIds.map((child): ElementId | GroupId => {
      if (typeof child !== "string")
        throw new TypeError("Invalid Group child ID.");
      return child.startsWith("el_")
        ? parseElementId(child)
        : parseGroupId(child);
    }),
  );
  if (new Set(childIds).size !== childIds.length) {
    throw new TypeError("A Group cannot contain duplicate children.");
  }
  const angle = data.selectionRotationRadians;
  if (
    typeof angle !== "number" ||
    !Number.isFinite(angle) ||
    angle < -Math.PI ||
    angle >= Math.PI
  ) {
    throw new RangeError("Group rotation is not canonical.");
  }
  return materializeGroupRecordV1({
    groupId: id,
    childIds,
    selectionRotationRadians: angle,
  });
}

function groups(
  value: unknown,
  budget: ValidationBudgetV1,
): readonly GroupReplacementV1[] {
  if (!Array.isArray(value)) throw new TypeError("Invalid Group replacements.");
  consume(budget, value.length);
  let previous: GroupId | null = null;
  return Object.freeze(
    value.map((candidate) => {
      const data = dataRecord(candidate, ["groupId", "prior", "replacement"]);
      const id = groupId(data.groupId);
      if (previous !== null && previous >= id) {
        throw new TypeError("Group replacements must be uniquely sorted.");
      }
      previous = id;
      const prior =
        data.prior === null ? null : groupRecord(data.prior, id, budget);
      const replacement =
        data.replacement === null
          ? null
          : groupRecord(data.replacement, id, budget);
      if (canonicalValueEqualsV1(prior, replacement)) {
        throw new TypeError("A Group replacement must change its value.");
      }
      return Object.freeze({ groupId: id, prior, replacement });
    }),
  );
}

function appearance(value: unknown): NoteAppearanceV1 {
  const data = dataRecord(value, [
    "background",
    "contrast",
    "horizontalSpacing",
  ]);
  if (
    !["none", "ruled", "squared", "dotted"].includes(
      data.background as string,
    ) ||
    !["compact", "standard", "wide"].includes(
      data.horizontalSpacing as string,
    ) ||
    !["low", "medium", "high"].includes(data.contrast as string)
  ) {
    throw new TypeError("Invalid note appearance.");
  }
  return materializeNoteAppearanceV1(data as unknown as NoteAppearanceV1);
}

function createElementsMember(
  value: unknown,
  budget: ValidationBudgetV1,
): BatchMemberV1 {
  const data = dataRecord(value, ["elements", "kind", "placement"]);
  const elements = elementValues(data.elements, budget);
  const target = placement(data.placement, budget);
  if (
    elements.length !== target.movedElementIds.length ||
    elements.some(
      ({ elementId: id }, index) => target.movedElementIds[index] !== id,
    )
  ) {
    throw new TypeError("Created element IDs must equal placement IDs.");
  }
  return Object.freeze({
    kind: "create-elements",
    elements,
    placement: target,
  });
}

function deleteElementsMember(
  value: unknown,
  budget: ValidationBudgetV1,
): BatchMemberV1 {
  const data = dataRecord(value, ["elements", "kind", "priorPlacement"]);
  const elements = elementValues(data.elements, budget);
  const priorPlacement = placement(data.priorPlacement, budget);
  if (
    elements.length !== priorPlacement.movedElementIds.length ||
    elements.some(
      ({ elementId: id }, index) =>
        priorPlacement.movedElementIds[index] !== id,
    )
  ) {
    throw new TypeError("Deleted element IDs must equal placement IDs.");
  }
  return Object.freeze({ kind: "delete-elements", elements, priorPlacement });
}

function validateMember(
  value: unknown,
  budget: ValidationBudgetV1,
): BatchMemberV1 {
  if (value === null || typeof value !== "object")
    throw new TypeError("Invalid patch.");
  const kind = dataDiscriminator(value);
  switch (kind) {
    case "create-elements":
      return createElementsMember(value, budget);
    case "delete-elements":
      return deleteElementsMember(value, budget);
    case "replace-geometry": {
      const data = dataRecord(value, ["changes", "kind"]);
      return Object.freeze({
        kind,
        changes: replacements(
          data.changes,
          budget,
          validateAnyNonLinearGeometry,
        ),
      });
    }
    case "replace-style": {
      const data = dataRecord(value, ["changes", "kind"]);
      return Object.freeze({
        kind,
        changes: replacements(data.changes, budget, validateAnyStyle),
      });
    }
    case "replace-binding": {
      const data = dataRecord(value, ["changes", "kind"]);
      return Object.freeze({
        kind,
        changes: replacements<ElementBinding>(
          data.changes,
          budget,
          validateElementBindingV1,
        ),
      });
    }
    case "replace-linear-geometry": {
      const data = dataRecord(value, ["changes", "kind"]);
      return Object.freeze({
        kind,
        changes: replacements<LinearGeometryV1>(
          data.changes,
          budget,
          validateLinearGeometryV1,
        ),
      });
    }
    case "replace-object-order": {
      const data = dataRecord(value, ["kind", "prior", "replacement"]);
      const prior = placement(data.prior, budget);
      const replacement = placement(data.replacement, budget);
      if (canonicalValueEqualsV1(prior, replacement)) {
        throw new TypeError("An order replacement must move its block.");
      }
      return Object.freeze({ kind, prior, replacement });
    }
    case "replace-groups": {
      const data = dataRecord(value, ["changes", "kind"]);
      return Object.freeze({ kind, changes: groups(data.changes, budget) });
    }
    case "replace-note-appearance": {
      const data = dataRecord(value, ["kind", "prior", "replacement"]);
      const prior = appearance(data.prior);
      const replacement = appearance(data.replacement);
      if (canonicalValueEqualsV1(prior, replacement)) {
        throw new TypeError("An appearance replacement must change its value.");
      }
      return Object.freeze({ kind, prior, replacement });
    }
    default:
      throw new TypeError("Unknown annotation patch discriminator.");
  }
}

function validatePatch(
  value: unknown,
  budget: ValidationBudgetV1,
): AnnotationPatchV1 {
  if (
    value !== null &&
    typeof value === "object" &&
    dataDiscriminator(value) === "atomic-batch"
  ) {
    const data = dataRecord(value, ["kind", "operations"]);
    if (!Array.isArray(data.operations))
      throw new TypeError("Invalid atomic batch.");
    consume(budget, data.operations.length);
    return Object.freeze({
      kind: "atomic-batch",
      operations: Object.freeze(
        data.operations.map((member) => validateMember(member, budget)),
      ),
    });
  }
  return validateMember(value, budget);
}

export function validateAnnotationPatchV1(
  value: unknown,
): AnnotationPatchResultV1<AnnotationPatchV1> {
  try {
    return Object.freeze({
      ok: true,
      value: validatePatch(value, { remaining: MAX_PATCH_ITEMS_V1 }),
    });
  } catch (error) {
    if (error instanceof RangeError) {
      return Object.freeze({ ok: false, code: "resource-limit" });
    }
    return Object.freeze({ ok: false, code: "invalid-operation" });
  }
}
