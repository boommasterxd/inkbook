/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact generated scene positions exercise canonical ordering and path-copy limits. */
import { describe, expect, it } from "vitest";

import { createSceneRevision, parseGroupId } from "../../../src/domain/model";
import {
  createRuntimeSceneStateV1,
  materializeSerializedSceneStateV1,
  type NoteAppearanceV1,
  type RuntimeSceneStateV1,
  updateRuntimeSceneStateV1,
} from "../../../src/domain/scene";
import { elementIdFor, rectangleElement } from "../model/support";

const MINIMUM_SCENE_SIZE = 5_000;
const STRESS_SCENE_SIZE = 10_000;
const REPLACEMENT_INDEX = 4_321;
const PATH_COPY_NODE_BUDGET = 64;
const GROUP_ID_PAYLOAD_LENGTH = 26;

const NOTE_APPEARANCE: NoteAppearanceV1 = Object.freeze({
  background: "dotted",
  horizontalSpacing: "standard",
  contrast: "medium",
});

function groupIdFor(index: number): ReturnType<typeof parseGroupId> {
  const suffix = String(index);
  return parseGroupId(
    `grp_${"0".repeat(GROUP_ID_PAYLOAD_LENGTH - suffix.length)}${suffix}`,
  );
}

function generateRuntimeScene(size: number): RuntimeSceneStateV1 {
  const elements = Array.from({ length: size }, (_, index) =>
    rectangleElement(index),
  );
  return createRuntimeSceneStateV1({
    revision: createSceneRevision(0),
    elements,
    objectOrder: elements.map(({ elementId }) => elementId),
    groups: [],
    noteAppearance: NOTE_APPEARANCE,
  });
}

describe("RuntimeSceneStateV1", () => {
  it.each([MINIMUM_SCENE_SIZE, STRESS_SCENE_SIZE])(
    "constructs a deterministic %i-element persistent scene",
    (size) => {
      const scene = generateRuntimeScene(size);

      expect(scene.elementsById.size).toBe(size);
      expect(scene.objectOrder).toHaveLength(size);
      expect(scene.objectOrder.get(0)).toBe(elementIdFor(0));
      expect(scene.objectOrder.get(size - 1)).toBe(elementIdFor(size - 1));
      expect(Object.isFrozen(scene)).toBe(true);
      expect(Object.isFrozen(scene.noteAppearance)).toBe(true);
    },
  );

  it("replaces one record by path-copy without allocating a flat scene array", () => {
    const scene = generateRuntimeScene(STRESS_SCENE_SIZE);
    const priorFirst = scene.elementsById.get(elementIdFor(0));
    const priorLast = scene.elementsById.get(
      elementIdFor(STRESS_SCENE_SIZE - 1),
    );
    const replacement = {
      ...rectangleElement(REPLACEMENT_INDEX),
      geometry: {
        ...rectangleElement(REPLACEMENT_INDEX).geometry,
        width: 2,
      },
    };
    const updated = updateRuntimeSceneStateV1(scene, {
      revision: createSceneRevision(1),
      elements: [[elementIdFor(REPLACEMENT_INDEX), replacement]],
    });

    expect(updated.scene.objectOrder).toBe(scene.objectOrder);
    expect(updated.scene.groupsById).toBe(scene.groupsById);
    expect(updated.scene.elementsById.get(elementIdFor(0))).toBe(priorFirst);
    expect(
      updated.scene.elementsById.get(elementIdFor(STRESS_SCENE_SIZE - 1)),
    ).toBe(priorLast);
    expect(updated.stats.affectedElementIds).toEqual([
      elementIdFor(REPLACEMENT_INDEX),
    ]);
    expect(updated.stats.elementStore.visitedNodes).toBeLessThan(
      PATH_COPY_NODE_BUDGET,
    );
    expect(updated.stats.elementStore.allocatedNodes).toBeLessThan(
      PATH_COPY_NODE_BUDGET,
    );
  });
});

describe("runtime Group path copying", () => {
  it("path-copies only the affected Group record", () => {
    const elements = Array.from({ length: STRESS_SCENE_SIZE }, (_, index) =>
      rectangleElement(index),
    );
    const groups = Array.from(
      { length: STRESS_SCENE_SIZE / 2 },
      (_, index) => ({
        groupId: groupIdFor(index),
        childIds: [elementIdFor(index * 2), elementIdFor(index * 2 + 1)],
        selectionRotationRadians: 0,
      }),
    );
    const scene = createRuntimeSceneStateV1({
      revision: createSceneRevision(0),
      elements,
      objectOrder: elements.map(({ elementId }) => elementId),
      groups,
      noteAppearance: NOTE_APPEARANCE,
    });
    const changedGroup = groupIdFor(REPLACEMENT_INDEX);
    const updated = updateRuntimeSceneStateV1(scene, {
      revision: createSceneRevision(1),
      groups: [
        [
          changedGroup,
          {
            groupId: changedGroup,
            childIds: [
              elementIdFor(REPLACEMENT_INDEX * 2),
              elementIdFor(REPLACEMENT_INDEX * 2 + 1),
            ],
            selectionRotationRadians: 1,
          },
        ],
      ],
    });

    expect(updated.scene.elementsById).toBe(scene.elementsById);
    expect(updated.scene.objectOrder).toBe(scene.objectOrder);
    expect(updated.stats.affectedGroupIds).toEqual([changedGroup]);
    expect(updated.stats.groupStore.visitedNodes).toBeLessThan(
      PATH_COPY_NODE_BUDGET,
    );
    expect(updated.stats.groupStore.allocatedNodes).toBeLessThan(
      PATH_COPY_NODE_BUDGET,
    );
  });
});

describe("scene codec-boundary materialization", () => {
  it("materializes canonical element, object, and Group order only at the codec boundary", () => {
    const firstGroupId = groupIdFor(1);
    const secondGroupId = groupIdFor(2);
    const elements = [
      rectangleElement(2),
      rectangleElement(0),
      rectangleElement(1),
    ];
    const scene = createRuntimeSceneStateV1({
      revision: createSceneRevision(1),
      elements,
      objectOrder: [elementIdFor(0), elementIdFor(1), elementIdFor(2)],
      groups: [
        {
          groupId: secondGroupId,
          childIds: [elementIdFor(0), elementIdFor(1)],
          selectionRotationRadians: 0,
        },
        {
          groupId: firstGroupId,
          childIds: [secondGroupId, elementIdFor(2)],
          selectionRotationRadians: 0,
        },
      ],
      noteAppearance: NOTE_APPEARANCE,
    });
    const serialized = materializeSerializedSceneStateV1(scene);

    expect(serialized.elements.map(({ elementId }) => elementId)).toEqual(
      serialized.objectOrder,
    );
    expect(serialized.groups.map(({ groupId }) => groupId)).toEqual([
      firstGroupId,
      secondGroupId,
    ]);
    expect(Object.isFrozen(serialized)).toBe(true);
    expect(Object.isFrozen(serialized.elements)).toBe(true);
    expect(Object.isFrozen(serialized.objectOrder)).toBe(true);
    expect(Object.isFrozen(serialized.groups)).toBe(true);
    expect(Object.isFrozen(serialized.groups[0]?.childIds)).toBe(true);
  });

  it("rejects duplicate runtime records and missing materialization references", () => {
    const element = rectangleElement(0);
    expect(() =>
      createRuntimeSceneStateV1({
        revision: createSceneRevision(0),
        elements: [element, element],
        objectOrder: [element.elementId],
        groups: [],
        noteAppearance: NOTE_APPEARANCE,
      }),
    ).toThrow(TypeError);

    const missing = createRuntimeSceneStateV1({
      revision: createSceneRevision(0),
      elements: [],
      objectOrder: [element.elementId],
      groups: [],
      noteAppearance: NOTE_APPEARANCE,
    });
    expect(() => materializeSerializedSceneStateV1(missing)).toThrow(TypeError);
  });
});
