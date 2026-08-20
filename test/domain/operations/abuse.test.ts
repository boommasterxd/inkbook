/* eslint-disable @typescript-eslint/no-magic-numbers -- Malicious boundary fixtures intentionally exercise exact invalid values. */
import { expect, it } from "vitest";

import { parseGroupId } from "../../../src/domain/model";
import {
  createAnnotationHistoryEntryV1,
  createAnnotationOperationV1,
  createHistoryEpoch,
  createAnnotationDependencyIndexV1,
  parseHistoryEntryId,
  parseOperationId,
  validateAnnotationPatchV1,
} from "../../../src/domain/operations";
import { PersistentSequenceV1 } from "../../../src/domain/scene";
import {
  elementIdFor,
  fixedBinding,
  operation,
  rectangle,
  scene,
  valueOf,
} from "./support";

const GROUP_ID = parseGroupId(`grp_${"0".repeat(26)}`);
const ELEMENT = valueOf(rectangle(0));

it.each([
  null,
  {},
  { kind: "unknown" },
  { kind: "atomic-batch", operations: [] },
  { kind: "atomic-batch", operations: "invalid" },
  { kind: "create-elements", elements: [], placement: {} },
  { kind: "create-elements", elements: "invalid", placement: {} },
  {
    kind: "create-elements",
    elements: [ELEMENT, ELEMENT],
    placement: {
      movedElementIds: [ELEMENT.elementId, ELEMENT.elementId],
      predecessorId: null,
      successorId: null,
    },
  },
  {
    kind: "create-elements",
    elements: [ELEMENT],
    placement: {
      movedElementIds: [ELEMENT.elementId],
      predecessorId: ELEMENT.elementId,
      successorId: null,
    },
  },
  { kind: "replace-geometry", changes: [] },
  { kind: "replace-geometry", changes: "invalid" },
  {
    kind: "replace-geometry",
    changes: [
      {
        elementId: "invalid",
        prior: ELEMENT.geometry,
        replacement: ELEMENT.geometry,
      },
    ],
  },
  {
    kind: "replace-binding",
    changes: [
      {
        elementId: ELEMENT.elementId,
        prior: fixedBinding(0),
        replacement: { ...fixedBinding(1), anchorX: Number.NaN },
      },
    ],
  },
  { kind: "replace-groups", changes: [] },
  {
    kind: "replace-groups",
    changes: [
      {
        groupId: GROUP_ID,
        prior: null,
        replacement: {
          groupId: GROUP_ID,
          childIds: [ELEMENT.elementId],
          selectionRotationRadians: 0,
        },
      },
    ],
  },
  {
    kind: "replace-groups",
    changes: [
      {
        groupId: GROUP_ID,
        prior: null,
        replacement: {
          groupId: GROUP_ID,
          childIds: [ELEMENT.elementId, ELEMENT.elementId],
          selectionRotationRadians: 0,
        },
      },
    ],
  },
  {
    kind: "replace-groups",
    changes: [
      {
        groupId: GROUP_ID,
        prior: null,
        replacement: {
          groupId: GROUP_ID,
          childIds: [ELEMENT.elementId, elementIdFor(1)],
          selectionRotationRadians: Math.PI,
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
      background: "invalid",
      horizontalSpacing: "wide",
      contrast: "high",
    },
  },
])("rejects malicious patch input without throwing: %#", (candidate) => {
  expect(() => validateAnnotationPatchV1(candidate)).not.toThrow();
  expect(validateAnnotationPatchV1(candidate).ok).toBe(false);
});

it("rejects a patch above its bounded member budget before member validation", () => {
  const oversized = {
    kind: "atomic-batch",
    operations: Array.from({ length: 100_001 }, () => null),
  };
  expect(validateAnnotationPatchV1(oversized)).toEqual({
    ok: false,
    code: "resource-limit",
  });
});

it("validates every envelope scalar and closed member set", () => {
  const valid = operation({
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
  });
  const invalidValues = [
    { ...valid, historyEntryId: "invalid" },
    { ...valid, historyEpoch: 0 },
    { ...valid, direction: "sideways" },
    { ...valid, expectedSceneRevision: -1 },
    { ...valid, extra: true },
  ];
  for (const candidate of invalidValues) {
    expect(createAnnotationOperationV1(candidate).ok).toBe(false);
  }
  expect(() => parseOperationId("invalid")).toThrow(TypeError);
  expect(() => parseHistoryEntryId("invalid")).toThrow(TypeError);
  expect(() => createHistoryEpoch(0)).toThrow(RangeError);
});

it("rejects duplicate object-order IDs and invalid local placement variants", () => {
  const duplicateSequence = PersistentSequenceV1.fromIterable([
    elementIdFor(0),
    elementIdFor(0),
  ]);
  const invalidScene = {
    ...scene([rectangle(0)]),
    objectOrder: duplicateSequence,
  };
  expect(createAnnotationDependencyIndexV1(invalidScene)).toEqual({
    ok: false,
    code: "invalid-operation",
  });

  const indexed = createAnnotationDependencyIndexV1(
    scene([rectangle(0), rectangle(1), rectangle(2)]),
  );
  expect(indexed.ok).toBe(true);
  if (!indexed.ok) return;
  const order = indexed.value.objectOrder;
  expect(
    order.insert({
      movedElementIds: [elementIdFor(0)],
      predecessorId: null,
      successorId: elementIdFor(1),
    }),
  ).toEqual({ ok: false, code: "invalid-placement" });
  expect(
    order.delete({
      movedElementIds: [elementIdFor(0), elementIdFor(2)],
      predecessorId: null,
      successorId: null,
    }),
  ).toEqual({ ok: false, code: "invalid-placement" });
  expect(
    order.move(
      {
        movedElementIds: [elementIdFor(0)],
        predecessorId: null,
        successorId: elementIdFor(1),
      },
      {
        movedElementIds: [elementIdFor(1)],
        predecessorId: elementIdFor(2),
        successorId: null,
      },
    ),
  ).toEqual({ ok: false, code: "invalid-placement" });
});

it.each([
  {
    kind: "replace-geometry",
    changes: [
      {
        elementId: ELEMENT.elementId,
        prior: rectangle(0).geometry,
        replacement: { ...rectangle(0).geometry, width: 2 },
      },
      {
        elementId: ELEMENT.elementId,
        prior: rectangle(0).geometry,
        replacement: { ...rectangle(0).geometry, width: 3 },
      },
    ],
  },
  {
    kind: "replace-geometry",
    changes: [{ elementId: 3, prior: ELEMENT.geometry, replacement: {} }],
  },
  { kind: "replace-groups", changes: "invalid" },
  {
    kind: "replace-groups",
    changes: [
      {
        groupId: GROUP_ID,
        prior: null,
        replacement: {
          groupId: parseGroupId(`grp_${"1".repeat(26)}`),
          childIds: [ELEMENT.elementId, elementIdFor(1)],
          selectionRotationRadians: 0,
        },
      },
    ],
  },
  {
    kind: "replace-groups",
    changes: [
      {
        groupId: GROUP_ID,
        prior: null,
        replacement: {
          groupId: GROUP_ID,
          childIds: "invalid",
          selectionRotationRadians: 0,
        },
      },
    ],
  },
  {
    kind: "replace-groups",
    changes: [
      {
        groupId: GROUP_ID,
        prior: null,
        replacement: {
          groupId: GROUP_ID,
          childIds: [ELEMENT.elementId, 3],
          selectionRotationRadians: 0,
        },
      },
    ],
  },
  {
    kind: "replace-groups",
    changes: [
      {
        groupId: GROUP_ID,
        prior: {
          groupId: GROUP_ID,
          childIds: [ELEMENT.elementId, elementIdFor(1)],
          selectionRotationRadians: 0,
        },
        replacement: {
          groupId: GROUP_ID,
          childIds: [ELEMENT.elementId, elementIdFor(1)],
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
      background: "none",
      horizontalSpacing: "standard",
      contrast: "medium",
    },
  },
  {
    kind: "replace-object-order",
    prior: {
      movedElementIds: "invalid",
      predecessorId: null,
      successorId: null,
    },
    replacement: {},
  },
  {
    kind: "replace-object-order",
    prior: {
      movedElementIds: [ELEMENT.elementId, ELEMENT.elementId],
      predecessorId: null,
      successorId: null,
    },
    replacement: {},
  },
  {
    kind: "replace-object-order",
    prior: {
      movedElementIds: [ELEMENT.elementId],
      predecessorId: null,
      successorId: ELEMENT.elementId,
    },
    replacement: {},
  },
  {
    kind: "replace-object-order",
    prior: {
      movedElementIds: [ELEMENT.elementId],
      predecessorId: null,
      successorId: null,
    },
    replacement: {
      movedElementIds: [ELEMENT.elementId],
      predecessorId: null,
      successorId: null,
    },
  },
  {
    kind: "delete-elements",
    elements: [ELEMENT],
    priorPlacement: {
      movedElementIds: [elementIdFor(1)],
      predecessorId: null,
      successorId: null,
    },
  },
])("rejects additional closed-record abuse case %#", (candidate) => {
  expect(validateAnnotationPatchV1(candidate).ok).toBe(false);
});

it("rejects non-plain and accessor patch records", () => {
  let accessorReads = 0;
  const derived = Object.create({ inherited: true }) as Record<string, unknown>;
  Object.assign(derived, { kind: "replace-geometry", changes: [] });
  const accessor = Object.defineProperties(
    {},
    {
      kind: { enumerable: true, value: "replace-geometry" },
      changes: {
        enumerable: true,
        get: (): never[] => {
          accessorReads += 1;
          return [];
        },
      },
    },
  );
  expect(validateAnnotationPatchV1(derived).ok).toBe(false);
  expect(validateAnnotationPatchV1(accessor).ok).toBe(false);
  expect(accessorReads).toBe(0);
});

it("rejects accessor envelopes without invoking their getters", () => {
  let operationIdReads = 0;
  const envelope = Object.defineProperties(
    {},
    {
      direction: { enumerable: true, value: "forward" },
      expectedSceneRevision: { enumerable: true, value: 0 },
      historyEntryId: {
        enumerable: true,
        value: `he_${"0".repeat(26)}`,
      },
      historyEpoch: { enumerable: true, value: 1 },
      operationId: {
        enumerable: true,
        get: (): string => {
          operationIdReads += 1;
          return `op_${"0".repeat(26)}`;
        },
      },
      patch: {
        enumerable: true,
        value: {
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
      },
    },
  );
  expect(createAnnotationOperationV1(envelope)).toEqual({
    ok: false,
    code: "invalid-operation",
  });
  expect(operationIdReads).toBe(0);
});

it("rejects history entries with nonexclusive batch members", () => {
  const prior = rectangle(0).style;
  const result = createAnnotationHistoryEntryV1({
    historyEntryId: `he_${"0".repeat(26)}`,
    historyEpoch: 1,
    forward: {
      kind: "atomic-batch",
      operations: [
        {
          kind: "replace-style",
          changes: [
            {
              elementId: ELEMENT.elementId,
              prior,
              replacement: { ...prior, width: 2 },
            },
          ],
        },
        {
          kind: "replace-style",
          changes: [
            {
              elementId: ELEMENT.elementId,
              prior: { ...prior, width: 2 },
              replacement: { ...prior, width: 3 },
            },
          ],
        },
      ],
    },
  });
  expect(result).toEqual({ ok: false, code: "invalid-operation" });
});
