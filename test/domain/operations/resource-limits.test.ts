/* eslint-disable @typescript-eslint/no-magic-numbers -- Aggregate tests exercise exact V1 boundaries. */
import { expect, it } from "vitest";

import {
  applyAnnotationOperationV1,
  createAnnotationDependencyIndexV1,
  invertAnnotationPatchV1,
  type AnnotationPatchV1,
} from "../../../src/domain/operations";
import { SCENE_RESOURCE_LIMITS_V1 } from "../../../src/domain/scene";
import {
  elementIdFor,
  operation,
  pen,
  rectangle,
  scene,
  valueOf,
} from "./support";

it("enforces the record limit atomically and permits exact Undo", () => {
  const template = rectangle(0);
  const initial = scene(
    Array.from(
      { length: SCENE_RESOURCE_LIMITS_V1.maxRecords - 1 },
      (_, index) => ({ ...template, elementId: elementIdFor(index) }),
    ),
  );
  const indexed = createAnnotationDependencyIndexV1(initial);
  expect(indexed.ok).toBe(true);
  if (!indexed.ok) return;
  const atLimitElement = valueOf(
    rectangle(SCENE_RESOURCE_LIMITS_V1.maxRecords - 1),
  );
  const creation: AnnotationPatchV1 = {
    kind: "create-elements",
    elements: [atLimitElement],
    placement: {
      movedElementIds: [atLimitElement.elementId],
      predecessorId: elementIdFor(SCENE_RESOURCE_LIMITS_V1.maxRecords - 2),
      successorId: null,
    },
  };
  const atLimit = applyAnnotationOperationV1(
    initial,
    indexed.value,
    operation(creation),
  );
  expect(atLimit.ok).toBe(true);
  if (!atLimit.ok) return;
  expect(atLimit.value.dependencies.recordCount).toBe(
    SCENE_RESOURCE_LIMITS_V1.maxRecords,
  );

  const aboveLimitElement = valueOf(
    rectangle(SCENE_RESOURCE_LIMITS_V1.maxRecords),
  );
  const aboveLimitCreation = {
    kind: "create-elements" as const,
    elements: [aboveLimitElement],
    placement: {
      movedElementIds: [aboveLimitElement.elementId],
      predecessorId: atLimitElement.elementId,
      successorId: null,
    },
  };
  const aboveLimit: AnnotationPatchV1 = {
    kind: "atomic-batch",
    operations: [
      {
        kind: "replace-style",
        changes: [
          {
            elementId: template.elementId,
            prior: template.style,
            replacement: { ...template.style, width: 2 },
          },
        ],
      },
      aboveLimitCreation,
    ],
  };
  const emptyIndexed = createAnnotationDependencyIndexV1(scene([]));
  expect(emptyIndexed.ok).toBe(true);
  if (!emptyIndexed.ok) return;
  expect(
    applyAnnotationOperationV1(
      atLimit.value.scene,
      emptyIndexed.value,
      operation(aboveLimitCreation, 1, "1"),
    ),
  ).toEqual({ ok: false, code: "invalid-operation" });
  expect(
    applyAnnotationOperationV1(
      atLimit.value.scene,
      atLimit.value.dependencies,
      operation(aboveLimit, 1, "1"),
    ),
  ).toEqual({ ok: false, code: "resource-limit" });
  expect(
    atLimit.value.scene.elementsById.get(template.elementId)?.style.width,
  ).toBe(1);
  expect(
    atLimit.value.dependencies.objectOrder.positionOf(
      aboveLimitElement.elementId,
    ),
  ).toBe(-1);

  const undone = applyAnnotationOperationV1(
    atLimit.value.scene,
    atLimit.value.dependencies,
    operation(invertAnnotationPatchV1(creation), 1, "2"),
  );
  expect(undone.ok).toBe(true);
  if (!undone.ok) return;
  expect(undone.value.dependencies.recordCount).toBe(
    SCENE_RESOURCE_LIMITS_V1.maxRecords - 1,
  );
  expect(undone.value.scene.revision).toBe(2);
}, 20_000);

it("enforces aggregate stroke points for batches and exact Undo", () => {
  const first = pen(0, 1);
  const second = pen(1, 200_000);
  const third = pen(2, 200_000);
  const changed = pen(3, 99_998);
  const initial = scene([first, second, third, changed]);
  const indexed = createAnnotationDependencyIndexV1(initial);
  expect(indexed.ok).toBe(true);
  if (!indexed.ok) return;
  expect(indexed.value.strokePointCount).toBe(
    SCENE_RESOURCE_LIMITS_V1.maxStrokePoints - 1,
  );
  const rotationChange = {
    elementId: first.elementId,
    prior: first.geometry,
    replacement: { ...first.geometry, selectionRotationRadians: 1 },
  };
  const atLimitGeometry = pen(3, 99_999).geometry;
  const atLimitPatch: AnnotationPatchV1 = {
    kind: "atomic-batch",
    operations: [
      { kind: "replace-geometry", changes: [rotationChange] },
      {
        kind: "replace-geometry",
        changes: [
          {
            elementId: changed.elementId,
            prior: changed.geometry,
            replacement: atLimitGeometry,
          },
        ],
      },
    ],
  };
  const atLimit = applyAnnotationOperationV1(
    initial,
    indexed.value,
    operation(atLimitPatch),
  );
  expect(atLimit.ok).toBe(true);
  if (!atLimit.ok) return;
  expect(atLimit.value.dependencies.strokePointCount).toBe(
    SCENE_RESOURCE_LIMITS_V1.maxStrokePoints,
  );

  const aboveLimitPatch: AnnotationPatchV1 = {
    kind: "atomic-batch",
    operations: [
      { kind: "replace-geometry", changes: [rotationChange] },
      {
        kind: "replace-geometry",
        changes: [
          {
            elementId: changed.elementId,
            prior: changed.geometry,
            replacement: pen(3, 100_000).geometry,
          },
        ],
      },
    ],
  };
  expect(
    applyAnnotationOperationV1(
      initial,
      indexed.value,
      operation(aboveLimitPatch, 0, "1"),
    ),
  ).toEqual({ ok: false, code: "resource-limit" });
  expect(initial.elementsById.get(first.elementId)?.geometry).toEqual(
    first.geometry,
  );
  expect(initial.revision).toBe(0);

  const undone = applyAnnotationOperationV1(
    atLimit.value.scene,
    atLimit.value.dependencies,
    operation(invertAnnotationPatchV1(atLimitPatch), 1, "2"),
  );
  expect(undone.ok).toBe(true);
  if (!undone.ok) return;
  expect(undone.value.dependencies.strokePointCount).toBe(
    SCENE_RESOURCE_LIMITS_V1.maxStrokePoints - 1,
  );
  expect(undone.value.scene.revision).toBe(2);
});
