/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact relationship fixtures exercise closed dependency rules. */
import { expect, it } from "vitest";

import { createSceneRevision, parseGroupId } from "../../../src/domain/model";
import {
  applyAnnotationOperationV1,
  createAnnotationDependencyIndexV1,
  invertAnnotationPatchV1,
  type AnnotationPatchV1,
} from "../../../src/domain/operations";
import { createRuntimeSceneStateV1 } from "../../../src/domain/scene";
import {
  elementIdFor,
  line,
  NOTE_APPEARANCE,
  operation,
  rectangle,
  scene,
  valueOf,
} from "./support";

const GROUP_ID = parseGroupId(`grp_${"0".repeat(26)}`);

it("rejects target deletion without detachment and accepts the dependency-closed batch", () => {
  const target = rectangle(0);
  const attached = line(1, target.elementId);
  const initial = scene([target, attached]);
  const indexed = createAnnotationDependencyIndexV1(initial);
  expect(indexed.ok).toBe(true);
  if (!indexed.ok) return;
  const deletion: AnnotationPatchV1 = {
    kind: "delete-elements",
    elements: [valueOf(target)],
    priorPlacement: {
      movedElementIds: [target.elementId],
      predecessorId: null,
      successorId: attached.elementId,
    },
  };
  expect(
    applyAnnotationOperationV1(initial, indexed.value, operation(deletion)),
  ).toEqual({ ok: false, code: "invalid-operation" });

  const detachedGeometry = {
    ...attached.geometry,
    start: {
      ...attached.geometry.start,
      fallbackPoint: { x: 1, y: 0 },
      attachment: null,
    },
  };
  const batch: AnnotationPatchV1 = {
    kind: "atomic-batch",
    operations: [
      {
        kind: "replace-linear-geometry",
        changes: [
          {
            elementId: attached.elementId,
            prior: attached.geometry,
            replacement: detachedGeometry,
          },
        ],
      },
      deletion,
    ],
  };
  const deleted = applyAnnotationOperationV1(
    initial,
    indexed.value,
    operation(batch),
  );
  expect(deleted.ok).toBe(true);
  if (!deleted.ok) return;
  expect(deleted.value.scene.elementsById.has(target.elementId)).toBe(false);
  const restored = applyAnnotationOperationV1(
    deleted.value.scene,
    deleted.value.dependencies,
    operation(invertAnnotationPatchV1(batch), 1, "1"),
  );
  expect(restored.ok).toBe(true);
  if (!restored.ok) return;
  expect(
    restored.value.scene.elementsById.get(attached.elementId),
  ).toMatchObject({
    geometry: attached.geometry,
    geometryRevision: 2,
  });
});

it("requires reverse-indexed fallback updates with every target geometry transform", () => {
  const target = rectangle(0);
  const attached = line(1, target.elementId);
  const initial = scene([target, attached]);
  const indexed = createAnnotationDependencyIndexV1(initial);
  expect(indexed.ok).toBe(true);
  if (!indexed.ok) return;
  const targetChange = {
    kind: "replace-geometry" as const,
    changes: [
      {
        elementId: target.elementId,
        prior: target.geometry,
        replacement: { ...target.geometry, width: 2 },
      },
    ],
  };
  expect(
    applyAnnotationOperationV1(initial, indexed.value, operation(targetChange)),
  ).toEqual({ ok: false, code: "invalid-operation" });

  const complete: AnnotationPatchV1 = {
    kind: "atomic-batch",
    operations: [
      targetChange,
      {
        kind: "replace-linear-geometry",
        changes: [
          {
            elementId: attached.elementId,
            prior: attached.geometry,
            replacement: {
              ...attached.geometry,
              start: {
                ...attached.geometry.start,
                fallbackPoint: { x: 1, y: 0 },
              },
            },
          },
        ],
      },
    ],
  };
  expect(
    applyAnnotationOperationV1(initial, indexed.value, operation(complete)).ok,
  ).toBe(true);
});

it("enforces Group leaf-block equality and sparse parent closure", () => {
  const elements = [rectangle(0), rectangle(1), rectangle(2)];
  const initial = scene(elements);
  const indexed = createAnnotationDependencyIndexV1(initial);
  expect(indexed.ok).toBe(true);
  if (!indexed.ok) return;
  const valid: AnnotationPatchV1 = {
    kind: "replace-groups",
    changes: [
      {
        groupId: GROUP_ID,
        prior: null,
        replacement: {
          groupId: GROUP_ID,
          childIds: [elementIdFor(0), elementIdFor(1)],
          selectionRotationRadians: 0,
        },
      },
    ],
  };
  expect(
    applyAnnotationOperationV1(initial, indexed.value, operation(valid)).ok,
  ).toBe(true);

  const invalid: AnnotationPatchV1 = {
    kind: "replace-groups",
    changes: [
      {
        groupId: GROUP_ID,
        prior: null,
        replacement: {
          groupId: GROUP_ID,
          childIds: [elementIdFor(0), elementIdFor(2)],
          selectionRotationRadians: 0,
        },
      },
    ],
  };
  expect(
    applyAnnotationOperationV1(initial, indexed.value, operation(invalid)),
  ).toEqual({ ok: false, code: "invalid-operation" });
});

it("rejects an order change that interleaves an existing Group block", () => {
  const elements = [rectangle(0), rectangle(1), rectangle(2)];
  const initial = createRuntimeSceneStateV1({
    revision: createSceneRevision(0),
    elements,
    objectOrder: elements.map(({ elementId }) => elementId),
    groups: [
      {
        groupId: GROUP_ID,
        childIds: [elementIdFor(0), elementIdFor(1)],
        selectionRotationRadians: 0,
      },
    ],
    noteAppearance: NOTE_APPEARANCE,
  });
  const indexed = createAnnotationDependencyIndexV1(initial);
  expect(indexed.ok).toBe(true);
  if (!indexed.ok) return;
  const patch: AnnotationPatchV1 = {
    kind: "replace-object-order",
    prior: {
      movedElementIds: [elementIdFor(1)],
      predecessorId: elementIdFor(0),
      successorId: elementIdFor(2),
    },
    replacement: {
      movedElementIds: [elementIdFor(1)],
      predecessorId: elementIdFor(2),
      successorId: null,
    },
  };
  expect(
    applyAnnotationOperationV1(initial, indexed.value, operation(patch)),
  ).toEqual({ ok: false, code: "invalid-operation" });
});

it("rejects moving a foreign element between existing Group leaves", () => {
  const elements = [rectangle(0), rectangle(1), rectangle(2)];
  const initial = createRuntimeSceneStateV1({
    revision: createSceneRevision(0),
    elements,
    objectOrder: elements.map(({ elementId }) => elementId),
    groups: [
      {
        groupId: GROUP_ID,
        childIds: [elementIdFor(0), elementIdFor(1)],
        selectionRotationRadians: 0,
      },
    ],
    noteAppearance: NOTE_APPEARANCE,
  });
  const indexed = createAnnotationDependencyIndexV1(initial);
  expect(indexed.ok).toBe(true);
  if (!indexed.ok) return;
  const patch: AnnotationPatchV1 = {
    kind: "replace-object-order",
    prior: {
      movedElementIds: [elementIdFor(2)],
      predecessorId: elementIdFor(1),
      successorId: null,
    },
    replacement: {
      movedElementIds: [elementIdFor(2)],
      predecessorId: elementIdFor(0),
      successorId: elementIdFor(1),
    },
  };
  expect(
    applyAnnotationOperationV1(initial, indexed.value, operation(patch)),
  ).toEqual({ ok: false, code: "invalid-operation" });
  expect(initial.revision).toBe(0);
  expect(indexed.value.objectOrder.positionOf(elementIdFor(2))).toBe(2);
});

it("rejects creating a foreign element between existing Group leaves", () => {
  const initial = createRuntimeSceneStateV1({
    revision: createSceneRevision(0),
    elements: [rectangle(0), rectangle(1)],
    objectOrder: [elementIdFor(0), elementIdFor(1)],
    groups: [
      {
        groupId: GROUP_ID,
        childIds: [elementIdFor(0), elementIdFor(1)],
        selectionRotationRadians: 0,
      },
    ],
    noteAppearance: NOTE_APPEARANCE,
  });
  const indexed = createAnnotationDependencyIndexV1(initial);
  expect(indexed.ok).toBe(true);
  if (!indexed.ok) return;
  const created = valueOf(rectangle(2));
  const patch: AnnotationPatchV1 = {
    kind: "create-elements",
    elements: [created],
    placement: {
      movedElementIds: [created.elementId],
      predecessorId: elementIdFor(0),
      successorId: elementIdFor(1),
    },
  };
  expect(
    applyAnnotationOperationV1(initial, indexed.value, operation(patch)),
  ).toEqual({ ok: false, code: "invalid-operation" });
  expect(initial.elementsById.has(created.elementId)).toBe(false);
  expect(initial.objectOrder).toHaveLength(2);
});

it("moves a complete Group leaf block through Forward, Undo, and Redo", () => {
  const elements = [rectangle(0), rectangle(1), rectangle(2)];
  const initial = createRuntimeSceneStateV1({
    revision: createSceneRevision(0),
    elements,
    objectOrder: elements.map(({ elementId }) => elementId),
    groups: [
      {
        groupId: GROUP_ID,
        childIds: [elementIdFor(0), elementIdFor(1)],
        selectionRotationRadians: 0,
      },
    ],
    noteAppearance: NOTE_APPEARANCE,
  });
  const indexed = createAnnotationDependencyIndexV1(initial);
  expect(indexed.ok).toBe(true);
  if (!indexed.ok) return;
  const patch: AnnotationPatchV1 = {
    kind: "replace-object-order",
    prior: {
      movedElementIds: [elementIdFor(0), elementIdFor(1)],
      predecessorId: null,
      successorId: elementIdFor(2),
    },
    replacement: {
      movedElementIds: [elementIdFor(0), elementIdFor(1)],
      predecessorId: elementIdFor(2),
      successorId: null,
    },
  };
  const forward = applyAnnotationOperationV1(
    initial,
    indexed.value,
    operation(patch),
  );
  expect(forward.ok).toBe(true);
  if (!forward.ok) return;
  expect(forward.value.scene.revision).toBe(1);
  const undo = applyAnnotationOperationV1(
    forward.value.scene,
    forward.value.dependencies,
    operation(invertAnnotationPatchV1(patch), 1, "1"),
  );
  expect(undo.ok).toBe(true);
  if (!undo.ok) return;
  expect(undo.value.scene.revision).toBe(2);
  const redo = applyAnnotationOperationV1(
    undo.value.scene,
    undo.value.dependencies,
    operation(patch, 2, "2"),
  );
  expect(redo.ok).toBe(true);
  if (!redo.ok) return;
  expect(redo.value.scene.revision).toBe(3);
  expect(redo.value.dependencies.objectOrder.positionOf(elementIdFor(2))).toBe(
    0,
  );
});

it("rejects the 1,025th endpoint attachment to one target", () => {
  const target = rectangle(0);
  const atLimit = Array.from({ length: 1_024 }, (_, index) =>
    line(index + 1, target.elementId),
  );
  expect(
    createAnnotationDependencyIndexV1(scene([target, ...atLimit])).ok,
  ).toBe(true);
  const attached = Array.from({ length: 1_025 }, (_, index) =>
    line(index + 1, target.elementId),
  );
  const indexed = createAnnotationDependencyIndexV1(
    scene([target, ...attached]),
  );
  expect(indexed).toEqual({ ok: false, code: "resource-limit" });
});
