/* eslint-disable @typescript-eslint/no-magic-numbers -- Structural performance fixtures use declared 5K and 10K tiers. */
import { expect, it } from "vitest";

import {
  createSceneRevision,
  parseGroupId,
  type GroupId,
} from "../../../src/domain/model";
import {
  applyAnnotationOperationV1,
  createAnnotationDependencyIndexV1,
  ORDER_KEY_BIT_LIMIT_V1,
  type AnnotationPatchV1,
} from "../../../src/domain/operations";
import { createRuntimeSceneStateV1 } from "../../../src/domain/scene";
import {
  elementIdFor,
  NOTE_APPEARANCE,
  operation,
  rectangle,
  scene,
} from "./support";

const MINIMUM_TIER = 5_000;
const STRESS_TIER = 10_000;
const PATH_VISIT_BUDGET = 256;
const REQUIRED_SAME_GAP_MOVES = 1_000;
const REPEATED_MOVES = ORDER_KEY_BIT_LIMIT_V1 - 1;

function groupIdFor(index: number): GroupId {
  const suffix = index.toString().padStart(8, "0");
  return parseGroupId(`grp_${"0".repeat(26 - suffix.length)}${suffix}`);
}

it.each([MINIMUM_TIER, STRESS_TIER])(
  "updates one element in a %i-element scene without visiting unrelated records",
  (size) => {
    const initial = scene(
      Array.from({ length: size }, (_, index) => rectangle(index)),
    );
    const indexed = createAnnotationDependencyIndexV1(initial);
    expect(indexed.ok).toBe(true);
    if (!indexed.ok) return;
    const target = rectangle(Math.floor(size / 2));
    const patch: AnnotationPatchV1 = {
      kind: "replace-style",
      changes: [
        {
          elementId: target.elementId,
          prior: target.style,
          replacement: { ...target.style, width: 2 },
        },
      ],
    };
    const result = applyAnnotationOperationV1(
      initial,
      indexed.value,
      operation(patch),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changes.elementIds).toEqual([target.elementId]);
    expect(result.value.scene.objectOrder).toBe(initial.objectOrder);
    expect(result.value.scene.groupsById).toBe(initial.groupsById);
    expect(result.value.scene.elementsById.get(elementIdFor(0))).toBe(
      initial.elementsById.get(elementIdFor(0)),
    );
    expect(result.value.scene.elementsById.get(elementIdFor(size - 1))).toBe(
      initial.elementsById.get(elementIdFor(size - 1)),
    );
  },
);

it("validates one sparse Group replacement without copying the 5K Group table", () => {
  const elements = Array.from({ length: STRESS_TIER }, (_, index) =>
    rectangle(index),
  );
  const groups = Array.from({ length: MINIMUM_TIER }, (_, index) => ({
    groupId: groupIdFor(index),
    childIds: [elementIdFor(index * 2), elementIdFor(index * 2 + 1)],
    selectionRotationRadians: 0,
  }));
  const initial = createRuntimeSceneStateV1({
    revision: createSceneRevision(0),
    elements,
    objectOrder: elements.map(({ elementId }) => elementId),
    groups,
    noteAppearance: NOTE_APPEARANCE,
  });
  const indexed = createAnnotationDependencyIndexV1(initial);
  expect(indexed.ok).toBe(true);
  if (!indexed.ok) return;
  const target = groups[Math.floor(groups.length / 2)];
  if (target === undefined) throw new Error("Missing generated Group");
  const patch: AnnotationPatchV1 = {
    kind: "replace-groups",
    changes: [
      {
        groupId: target.groupId,
        prior: target,
        replacement: { ...target, selectionRotationRadians: 1 },
      },
    ],
  };
  const result = applyAnnotationOperationV1(
    initial,
    indexed.value,
    operation(patch),
  );

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.changes.groupIds).toEqual([target.groupId]);
  expect(result.value.scene.elementsById).toBe(initial.elementsById);
  expect(result.value.scene.objectOrder).toBe(initial.objectOrder);
  expect(result.value.scene.groupsById.get(groupIdFor(0))).toBe(
    initial.groupsById.get(groupIdFor(0)),
  );
});

it.each([MINIMUM_TIER, STRESS_TIER])(
  "moves beside a %i-element Group without validating its unchanged leaf block",
  (size) => {
    const elements = Array.from({ length: size }, (_, index) =>
      rectangle(index),
    );
    const groupId = groupIdFor(0);
    const initial = createRuntimeSceneStateV1({
      revision: createSceneRevision(0),
      elements,
      objectOrder: elements.map(({ elementId }) => elementId),
      groups: [
        {
          groupId,
          childIds: elements.slice(0, -1).map(({ elementId }) => elementId),
          selectionRotationRadians: 0,
        },
      ],
      noteAppearance: NOTE_APPEARANCE,
    });
    const indexed = createAnnotationDependencyIndexV1(initial);
    expect(indexed.ok).toBe(true);
    if (!indexed.ok) return;
    const movedElementId = elementIdFor(size - 1);
    const patch: AnnotationPatchV1 = {
      kind: "replace-object-order",
      prior: {
        movedElementIds: [movedElementId],
        predecessorId: elementIdFor(size - 2),
        successorId: null,
      },
      replacement: {
        movedElementIds: [movedElementId],
        predecessorId: null,
        successorId: elementIdFor(0),
      },
    };
    const result = applyAnnotationOperationV1(
      initial,
      indexed.value,
      operation(patch),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changes.elementIds).toEqual([movedElementId]);
    expect(result.value.changes.groupIds).toEqual([]);
    expect(result.value.scene.groupsById).toBe(initial.groupsById);
  },
);

it("keeps repeated same-gap order updates logarithmic and key growth bounded", () => {
  const initial = scene(
    Array.from({ length: MINIMUM_TIER }, (_, index) => rectangle(index)),
  );
  const indexed = createAnnotationDependencyIndexV1(initial);
  expect(indexed.ok).toBe(true);
  if (!indexed.ok) return;
  let currentScene = initial;
  let currentDependencies = indexed.value;
  let order = currentDependencies.objectOrder;
  let maximumKeyBits = 0;
  let priorMaximumKeyBits = 0;
  for (let iteration = 0; iteration < REPEATED_MOVES; iteration += 1) {
    const movedId = elementIdFor(MINIMUM_TIER - 1 - iteration);
    const priorPredecessor = elementIdFor(MINIMUM_TIER - 2 - iteration);
    const prior = {
      movedElementIds: [movedId],
      predecessorId: priorPredecessor,
      successorId: null,
    };
    const replacement = {
      movedElementIds: [movedId],
      predecessorId: elementIdFor(0),
      successorId: elementIdFor(iteration === 0 ? 1 : MINIMUM_TIER - iteration),
    };
    const moved = order.move(prior, replacement);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.value.stats.visitedNodes).toBeLessThan(PATH_VISIT_BUDGET);
    priorMaximumKeyBits = maximumKeyBits;
    maximumKeyBits = Math.max(maximumKeyBits, moved.value.stats.maximumKeyBits);
    const applied = applyAnnotationOperationV1(
      currentScene,
      currentDependencies,
      operation(
        { kind: "replace-object-order", prior, replacement },
        iteration,
      ),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    currentScene = applied.value.scene;
    currentDependencies = applied.value.dependencies;
    order = currentDependencies.objectOrder;
    if (iteration + 1 === REQUIRED_SAME_GAP_MOVES) {
      expect(maximumKeyBits).toBe(REQUIRED_SAME_GAP_MOVES + 1);
    }
  }
  expect(priorMaximumKeyBits).toBe(ORDER_KEY_BIT_LIMIT_V1 - 1);
  expect(maximumKeyBits).toBe(ORDER_KEY_BIT_LIMIT_V1);
  const movedElementId = elementIdFor(MINIMUM_TIER - 1 - REPEATED_MOVES);
  const movedElementIds = [movedElementId];
  const prior = {
    movedElementIds,
    predecessorId: elementIdFor(MINIMUM_TIER - 2 - REPEATED_MOVES),
    successorId: null,
  };
  const replacement = {
    movedElementIds,
    predecessorId: elementIdFor(0),
    successorId: elementIdFor(MINIMUM_TIER - REPEATED_MOVES),
  };
  expect(order.move(prior, replacement)).toEqual({
    ok: false,
    code: "resource-limit",
  });

  const positionBeforeRejection = order.positionOf(movedElementId);
  const application = applyAnnotationOperationV1(
    currentScene,
    currentDependencies,
    operation(
      { kind: "replace-object-order", prior, replacement },
      REPEATED_MOVES,
    ),
  );
  expect(application).toEqual({ ok: false, code: "resource-limit" });
  expect(currentScene.revision).toBe(REPEATED_MOVES);
  expect(currentDependencies.objectOrder).toBe(order);
  expect(order.positionOf(movedElementId)).toBe(positionBeforeRejection);
}, 20_000);
