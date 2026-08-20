/* eslint-disable @typescript-eslint/no-magic-numbers -- Boundary fixtures exercise exact relationship limits. */
import { expect, it } from "vitest";

import {
  createSceneRevision,
  parseGroupId,
  type GroupId,
} from "../../../src/domain/model";
import {
  applyAnnotationOperationV1,
  createAnnotationDependencyIndexV1,
  type AnnotationOperationResultV1,
  type AnnotationPatchV1,
} from "../../../src/domain/operations";
import {
  createRuntimeSceneStateV1,
  type GroupRecordV1,
  type RuntimeSceneStateV1,
} from "../../../src/domain/scene";
import {
  elementIdFor,
  line,
  NOTE_APPEARANCE,
  operation,
  rectangle,
  scene,
  valueOf,
} from "./support";

function groupIdFor(index: number): GroupId {
  const suffix = index.toString().padStart(8, "0");
  return parseGroupId(`grp_${"0".repeat(26 - suffix.length)}${suffix}`);
}

function sceneWithGroups(
  elementCount: number,
  groups: readonly GroupRecordV1[],
): RuntimeSceneStateV1 {
  const elements = Array.from({ length: elementCount }, (_, index) =>
    rectangle(index),
  );
  return createRuntimeSceneStateV1({
    revision: createSceneRevision(0),
    elements,
    objectOrder: elements.map(({ elementId }) => elementId),
    groups,
    noteAppearance: NOTE_APPEARANCE,
  });
}

function apply(
  initial: RuntimeSceneStateV1,
  patch: AnnotationPatchV1,
): AnnotationOperationResultV1 {
  const indexed = createAnnotationDependencyIndexV1(initial);
  if (!indexed.ok) throw new Error("The test fixture must be indexable.");
  return applyAnnotationOperationV1(initial, indexed.value, operation(patch));
}

it.each([
  {
    name: "an unresolved attachment target",
    target: elementIdFor(2),
    initial: scene([rectangle(0)]),
  },
  {
    name: "a Line used as an attachment target",
    target: elementIdFor(0),
    initial: scene([line(0, null)]),
  },
])("rejects created linear geometry with $name", ({ initial, target }) => {
  const created = valueOf(line(1, target));
  const patch: AnnotationPatchV1 = {
    kind: "create-elements",
    elements: [created],
    placement: {
      movedElementIds: [created.elementId],
      predecessorId: elementIdFor(0),
      successorId: null,
    },
  };
  expect(apply(initial, patch)).toEqual({
    ok: false,
    code: "invalid-operation",
  });
});

it("rejects deleting an element that remains a direct Group child", () => {
  const groupId = groupIdFor(0);
  const initial = sceneWithGroups(2, [
    {
      groupId,
      childIds: [elementIdFor(0), elementIdFor(1)],
      selectionRotationRadians: 0,
    },
  ]);
  const patch: AnnotationPatchV1 = {
    kind: "delete-elements",
    elements: [valueOf(rectangle(0))],
    priorPlacement: {
      movedElementIds: [elementIdFor(0)],
      predecessorId: null,
      successorId: elementIdFor(1),
    },
  };
  expect(apply(initial, patch)).toEqual({
    ok: false,
    code: "invalid-operation",
  });
});

it.each([
  {
    name: "an unresolved child",
    childIds: [elementIdFor(0), elementIdFor(2)],
  },
  {
    name: "a direct cycle",
    childIds: [groupIdFor(0), elementIdFor(0)],
  },
])("rejects a Group with $name", ({ childIds }) => {
  const groupId = groupIdFor(0);
  const patch: AnnotationPatchV1 = {
    kind: "replace-groups",
    changes: [
      {
        groupId,
        prior: null,
        replacement: { groupId, childIds, selectionRotationRadians: 0 },
      },
    ],
  };
  expect(apply(scene([rectangle(0), rectangle(1)]), patch)).toEqual({
    ok: false,
    code: "invalid-operation",
  });
});

it("rejects a second direct parent for one child", () => {
  const firstGroupId = groupIdFor(0);
  const secondGroupId = groupIdFor(1);
  const initial = sceneWithGroups(3, [
    {
      groupId: firstGroupId,
      childIds: [elementIdFor(0), elementIdFor(1)],
      selectionRotationRadians: 0,
    },
  ]);
  const patch: AnnotationPatchV1 = {
    kind: "replace-groups",
    changes: [
      {
        groupId: secondGroupId,
        prior: null,
        replacement: {
          groupId: secondGroupId,
          childIds: [elementIdFor(0), elementIdFor(2)],
          selectionRotationRadians: 0,
        },
      },
    ],
  };
  expect(apply(initial, patch)).toEqual({
    ok: false,
    code: "invalid-operation",
  });
});

it("validates nested Group leaf order and rejects deleting a referenced child Group", () => {
  const childGroupId = groupIdFor(0);
  const parentGroupId = groupIdFor(1);
  const initial = sceneWithGroups(3, []);
  const childGroup = {
    groupId: childGroupId,
    childIds: [elementIdFor(0), elementIdFor(1)],
    selectionRotationRadians: 0,
  };
  const parentGroup = {
    groupId: parentGroupId,
    childIds: [childGroupId, elementIdFor(2)],
    selectionRotationRadians: 0,
  };
  const creation: AnnotationPatchV1 = {
    kind: "replace-groups",
    changes: [
      { groupId: childGroupId, prior: null, replacement: childGroup },
      { groupId: parentGroupId, prior: null, replacement: parentGroup },
    ],
  };
  const created = apply(initial, creation);
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  const deletion: AnnotationPatchV1 = {
    kind: "replace-groups",
    changes: [{ groupId: childGroupId, prior: childGroup, replacement: null }],
  };
  expect(
    applyAnnotationOperationV1(
      created.value.scene,
      created.value.dependencies,
      operation(deletion, 1, "1"),
    ),
  ).toEqual({ ok: false, code: "invalid-operation" });
});

it("rejects Group nesting deeper than the bounded V1 maximum", () => {
  const groupCount = 33;
  const groups = Array.from({ length: groupCount }, (_, index) => {
    const groupId = groupIdFor(index);
    return {
      groupId,
      childIds:
        index === 0
          ? [elementIdFor(0), elementIdFor(1)]
          : [groupIdFor(index - 1), elementIdFor(index + 1)],
      selectionRotationRadians: 0,
    };
  });
  const patch: AnnotationPatchV1 = {
    kind: "replace-groups",
    changes: groups.map((replacement) => ({
      groupId: replacement.groupId,
      prior: null,
      replacement,
    })),
  };
  expect(apply(sceneWithGroups(groupCount + 1, []), patch)).toEqual({
    ok: false,
    code: "resource-limit",
  });
});
