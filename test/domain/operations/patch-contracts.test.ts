/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact operation fixtures exercise revision and identity boundaries. */
import { expect, it } from "vitest";

import { parseGroupId } from "../../../src/domain/model";
import type {
  AnnotationPatchV1,
  BatchMemberV1,
} from "../../../src/domain/operations";
import {
  createAnnotationHistoryEntryV1,
  createAnnotationOperationV1,
  invertAnnotationPatchV1,
  parseHistoryEntryId,
  validateAnnotationHistoryEntryV1,
  validateAnnotationPatchV1,
} from "../../../src/domain/operations";
import {
  elementIdFor,
  fixedBinding,
  operation,
  rectangle,
  valueOf,
} from "./support";

const GROUP_ID = parseGroupId(`grp_${"0".repeat(26)}`);
const FIRST = valueOf(rectangle(0));
const SECOND = valueOf(rectangle(1));
const FIRST_RECTANGLE = rectangle(0);
const PLACEMENT = Object.freeze({
  movedElementIds: Object.freeze([FIRST.elementId]),
  predecessorId: null,
  successorId: null,
});

function variants(): readonly BatchMemberV1[] {
  return [
    { kind: "create-elements", elements: [FIRST], placement: PLACEMENT },
    {
      kind: "delete-elements",
      elements: [FIRST],
      priorPlacement: PLACEMENT,
    },
    {
      kind: "replace-geometry",
      changes: [
        {
          elementId: FIRST.elementId,
          prior: FIRST_RECTANGLE.geometry,
          replacement: { ...FIRST_RECTANGLE.geometry, width: 2 },
        },
      ],
    },
    {
      kind: "replace-style",
      changes: [
        {
          elementId: FIRST.elementId,
          prior: FIRST_RECTANGLE.style,
          replacement: { ...FIRST_RECTANGLE.style, width: 2 },
        },
      ],
    },
    {
      kind: "replace-binding",
      changes: [
        {
          elementId: FIRST.elementId,
          prior: fixedBinding(0),
          replacement: fixedBinding(2),
        },
      ],
    },
    {
      kind: "replace-linear-geometry",
      changes: [
        {
          elementId: elementIdFor(2),
          prior: {
            start: { fallbackPoint: { x: 0, y: 0 }, attachment: null },
            end: { fallbackPoint: { x: 1, y: 1 }, attachment: null },
            control: null,
          },
          replacement: {
            start: { fallbackPoint: { x: 1, y: 0 }, attachment: null },
            end: { fallbackPoint: { x: 1, y: 1 }, attachment: null },
            control: null,
          },
        },
      ],
    },
    {
      kind: "replace-object-order",
      prior: PLACEMENT,
      replacement: {
        movedElementIds: [FIRST.elementId],
        predecessorId: SECOND.elementId,
        successorId: null,
      },
    },
    {
      kind: "replace-groups",
      changes: [
        {
          groupId: GROUP_ID,
          prior: null,
          replacement: {
            groupId: GROUP_ID,
            childIds: [FIRST.elementId, SECOND.elementId],
            selectionRotationRadians: 0,
          },
        },
      ],
    },
    {
      kind: "replace-note-appearance",
      prior: {
        background: "none",
        horizontalSpacing: "standard",
        contrast: "medium",
      },
      replacement: {
        background: "dotted",
        horizontalSpacing: "wide",
        contrast: "high",
      },
    },
  ];
}

function variantAt(index: number): BatchMemberV1 {
  const value = variants()[index];
  if (value === undefined) throw new Error("Missing operation fixture");
  return value;
}

it("derives the exact involutive inverse for every closed patch variant", () => {
  for (const patch of variants()) {
    const validated = validateAnnotationPatchV1(patch);
    expect(validated.ok).toBe(true);
    if (!validated.ok) continue;
    expect(
      invertAnnotationPatchV1(invertAnnotationPatchV1(validated.value)),
    ).toEqual(validated.value);
  }
});

it("reverses atomic member order and contains no dispatch metadata", () => {
  const patch: AnnotationPatchV1 = {
    kind: "atomic-batch",
    operations: [variantAt(2), variantAt(4)],
  };
  const inverse = invertAnnotationPatchV1(patch);

  expect(inverse.kind).toBe("atomic-batch");
  if (inverse.kind !== "atomic-batch") return;
  expect(inverse.operations.map(({ kind }) => kind)).toEqual([
    "replace-binding",
    "replace-geometry",
  ]);
  expect(JSON.stringify(inverse)).not.toContain("operationId");
  expect(
    validateAnnotationPatchV1({
      kind: "atomic-batch",
      operations: [
        {
          ...variantAt(0),
          operationId: operation(variantAt(0)).operationId,
        },
      ],
    }).ok,
  ).toBe(false);
});

it("creates a stable immutable history entry and validates its exact inverse", () => {
  const created = createAnnotationHistoryEntryV1({
    historyEntryId: parseHistoryEntryId(`he_${"0".repeat(26)}`),
    historyEpoch: 1,
    forward: variants()[2],
  });

  expect(created.ok).toBe(true);
  if (!created.ok) return;
  expect(Object.isFrozen(created.value)).toBe(true);
  expect(validateAnnotationHistoryEntryV1(created.value)).toEqual(created);
  expect(
    validateAnnotationHistoryEntryV1({
      ...created.value,
      inverse: variants()[1],
    }).ok,
  ).toBe(false);
});

it("keeps one retry envelope stable while Forward, Undo, and Redo use fresh IDs", () => {
  const patch = variantAt(2);
  const forward = operation(patch, 0, "0");
  const retry = createAnnotationOperationV1(forward);
  const sameRetry = createAnnotationOperationV1(forward);
  const undo = {
    ...operation(invertAnnotationPatchV1(patch), 1, "1"),
    direction: "inverse" as const,
  };
  const redo = operation(patch, 2, "2");

  expect(retry).toEqual(sameRetry);
  expect(
    new Set([forward.operationId, undo.operationId, redo.operationId]).size,
  ).toBe(3);
  expect(forward.historyEntryId).toBe(undo.historyEntryId);
  expect(undo.historyEntryId).toBe(redo.historyEntryId);
});

it("rejects malformed IDs, nested batches, accessors, duplicates, and no-op values", () => {
  const accessor = Object.defineProperty({}, "kind", {
    enumerable: true,
    get: (): string => {
      throw new Error("hostile getter");
    },
  });
  expect(validateAnnotationPatchV1(accessor).ok).toBe(false);
  expect(
    validateAnnotationPatchV1({
      kind: "atomic-batch",
      operations: [{ kind: "atomic-batch", operations: [] }],
    }).ok,
  ).toBe(false);
  expect(
    validateAnnotationPatchV1({
      kind: "replace-style",
      changes: [
        {
          elementId: FIRST.elementId,
          prior: FIRST.style,
          replacement: FIRST.style,
        },
      ],
    }).ok,
  ).toBe(false);
  expect(
    createAnnotationOperationV1({
      ...operation(variantAt(0)),
      operationId: "op_invalid",
    }).ok,
  ).toBe(false);
});

it("enforces the aggregate Group-child patch budget below, at, and above its limit", () => {
  const children = Array.from({ length: 50_000 }, (_, index) =>
    elementIdFor(index),
  );
  const secondGroupId = parseGroupId(`grp_${"1".repeat(26)}`);
  const patchWithSecondChildCount = (
    secondCount: number,
  ): AnnotationPatchV1 => ({
    kind: "atomic-batch" as const,
    operations: [
      {
        kind: "replace-groups" as const,
        changes: [
          {
            groupId: GROUP_ID,
            prior: null,
            replacement: {
              groupId: GROUP_ID,
              childIds: children.slice(0, 49_998),
              selectionRotationRadians: 0,
            },
          },
        ],
      },
      {
        kind: "replace-groups" as const,
        changes: [
          {
            groupId: secondGroupId,
            prior: null,
            replacement: {
              groupId: secondGroupId,
              childIds: children.slice(0, secondCount),
              selectionRotationRadians: 0,
            },
          },
        ],
      },
    ],
  });

  expect(validateAnnotationPatchV1(patchWithSecondChildCount(49_997)).ok).toBe(
    true,
  );
  expect(validateAnnotationPatchV1(patchWithSecondChildCount(49_998)).ok).toBe(
    true,
  );
  expect(validateAnnotationPatchV1(patchWithSecondChildCount(49_999))).toEqual({
    ok: false,
    code: "resource-limit",
  });
});

it("rejects an accessor Group record without reading child IDs", () => {
  let childIdReads = 0;
  const replacement = Object.defineProperties(
    {},
    {
      childIds: {
        enumerable: true,
        get: (): readonly never[] => {
          childIdReads += 1;
          return [];
        },
      },
      groupId: { enumerable: true, value: GROUP_ID },
      selectionRotationRadians: { enumerable: true, value: 0 },
    },
  );
  expect(
    validateAnnotationPatchV1({
      kind: "replace-groups",
      changes: [{ groupId: GROUP_ID, prior: null, replacement }],
    }),
  ).toEqual({ ok: false, code: "invalid-operation" });
  expect(childIdReads).toBe(0);
});
