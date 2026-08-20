/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact scene indices and schema boundaries are intentional. */
import { describe, expect, it, vi } from "vitest";

import * as deltaVarintCodec from "../../../src/domain/codecs/delta-varint";
import * as elementModel from "../../../src/domain/model/elements";

import {
  validateGroupRecordV1,
  validateNoteAppearanceV1,
  validateSerializedSceneStateV1,
} from "../../../src/domain/codecs";
import type { ObjectPortIdV1, SceneElementV1 } from "../../../src/domain/model";
import {
  createBindingRevision,
  createGeometryRevision,
  createSceneRevision,
  createStyleRevision,
} from "../../../src/domain/model";
import { elementIdFor, rectangleElement } from "../model/support";
import { completeScene, everyElementKind, groupIdFor } from "./scene-support";

interface MutableGroup {
  groupId: string;
  childIds: string[];
  selectionRotationRadians: number;
}

interface MutableScene {
  revision: number;
  elements: SceneElementV1[];
  objectOrder: string[];
  groups: MutableGroup[];
  noteAppearance: object;
}

function mutableScene(): MutableScene {
  return structuredClone(completeScene()) as unknown as MutableScene;
}

function nestedScene(depth: number): unknown {
  const natural = Array.from({ length: depth + 1 }, (_, index) =>
    rectangleElement(index),
  );
  const elements: SceneElementV1[] = [];
  const deepestFirst = natural[depth - 1];
  const deepestSecond = natural[depth];
  if (deepestFirst === undefined || deepestSecond === undefined) {
    throw new TypeError("Nested scene requires at least one Group.");
  }
  elements.push(deepestFirst, deepestSecond);
  for (let index = depth - 2; index >= 0; index -= 1) {
    const element = natural[index];
    if (element !== undefined) elements.push(element);
  }
  const groups = Array.from({ length: depth }, (_, index) => ({
    groupId: groupIdFor(index),
    childIds:
      index === depth - 1
        ? [elementIdFor(depth - 1), elementIdFor(depth)]
        : [groupIdFor(index + 1), elementIdFor(index)],
    selectionRotationRadians: 0,
  }));
  return {
    revision: createSceneRevision(depth + 1),
    elements,
    objectOrder: elements.map(({ elementId }) => elementId),
    groups,
    noteAppearance: completeScene().noteAppearance,
  };
}

function penWithPointCount(index: number, pointCount: number): SceneElementV1 {
  const pen = everyElementKind()[0];
  if (pen?.kind !== "pen") throw new TypeError("Expected Pen fixture.");
  const revision = index + 1;
  return {
    ...pen,
    elementId: elementIdFor(index),
    geometryRevision: createGeometryRevision(revision),
    styleRevision: createStyleRevision(revision),
    bindingRevision: createBindingRevision(revision),
    geometry: {
      ...pen.geometry,
      stroke: {
        ...pen.geometry.stroke,
        pointCount,
        data: "A".repeat((pointCount - 1) * 4),
      },
    },
  };
}

describe("serialized scene record validation", () => {
  it("constructs a deeply immutable runtime scene after complete validation", () => {
    const runtime = validateSerializedSceneStateV1(completeScene());

    expect(runtime.elementsById.size).toBe(12);
    expect(runtime.groupsById.size).toBe(2);
    expect(runtime.objectOrder.get(0)).toBe(elementIdFor(0));
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Object.isFrozen(runtime.elementsById.get(elementIdFor(0)))).toBe(
      true,
    );
    expect(Object.isFrozen(runtime.noteAppearance)).toBe(true);
  });

  it("rejects unknown keys, duplicate IDs, alternate element order, and incomplete order", () => {
    expect(() =>
      validateSerializedSceneStateV1({ ...completeScene(), viewport: {} }),
    ).toThrow(/closed V1/u);
    expect(() =>
      validateSerializedSceneStateV1({
        ...completeScene(),
        elements: [null],
        objectOrder: [elementIdFor(0)],
      }),
    ).toThrow(/data object/u);

    const duplicate = mutableScene();
    const first = duplicate.elements[0];
    const second = duplicate.elements[1];
    if (first === undefined || second === undefined)
      throw new TypeError("Missing fixtures.");
    duplicate.elements[1] = { ...second, elementId: first.elementId };
    expect(() => validateSerializedSceneStateV1(duplicate)).toThrow(/unique/u);

    const alternate = mutableScene();
    alternate.elements.reverse();
    expect(() => validateSerializedSceneStateV1(alternate)).toThrow(
      /exactly equal/u,
    );

    const incomplete = mutableScene();
    incomplete.objectOrder.pop();
    expect(() => validateSerializedSceneStateV1(incomplete)).toThrow(/every/u);
  });

  it("rejects scene overflow and component revisions newer than the scene", () => {
    expect(() =>
      validateSerializedSceneStateV1({
        ...completeScene(),
        revision: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow(/revision/u);
    const source = completeScene();
    const elements = [...source.elements];
    const first = elements[0];
    if (first === undefined) throw new TypeError("Missing element fixture.");
    elements[0] = { ...first, geometryRevision: createGeometryRevision(13) };
    expect(() =>
      validateSerializedSceneStateV1({ ...source, elements }),
    ).toThrow(/cannot exceed/u);
  });
});

describe("serialized scene relationship validation", () => {
  it("rejects every invalid Group topology and canonical-order form", () => {
    const cases = [
      (scene: MutableScene): void => {
        scene.groups.reverse();
      },
      (scene: MutableScene): void => {
        const group = scene.groups[1];
        if (group === undefined) return;
        group.childIds = [elementIdFor(0)];
      },
      (scene: MutableScene): void => {
        const group = scene.groups[1];
        if (group === undefined) return;
        group.childIds = [elementIdFor(0), elementIdFor(0)];
      },
      (scene: MutableScene): void => {
        const group = scene.groups[1];
        if (group === undefined) return;
        group.childIds = [elementIdFor(0), elementIdFor(99)];
      },
      (scene: MutableScene): void => {
        const group = scene.groups[0];
        if (group === undefined) return;
        group.childIds = [groupIdFor(1), elementIdFor(3)];
      },
      (scene: MutableScene): void => {
        const group = scene.groups[1];
        if (group === undefined) return;
        group.childIds = [groupIdFor(0), elementIdFor(1)];
      },
    ];

    for (const corrupt of cases) {
      const scene = mutableScene();
      corrupt(scene);
      expect(() => validateSerializedSceneStateV1(scene)).toThrow();
    }
  });

  it("accepts 32 Group levels and rejects 33", () => {
    expect(() => validateSerializedSceneStateV1(nestedScene(32))).not.toThrow();
    expect(() => validateSerializedSceneStateV1(nestedScene(33))).toThrow(
      /nesting/u,
    );
  });

  it("rejects unresolved, unsupported, and excessive endpoint attachments", () => {
    const missing = mutableScene();
    const arrow = missing.elements[8];
    if (arrow?.kind !== "arrow") throw new TypeError("Expected Arrow fixture.");
    missing.elements[8] = {
      ...arrow,
      geometry: {
        ...arrow.geometry,
        start: {
          ...arrow.geometry.start,
          attachment: {
            targetElementId: elementIdFor(99),
            portId: "area:east",
          },
        },
      },
    };
    expect(() => validateSerializedSceneStateV1(missing)).toThrow(
      /attachment/u,
    );

    const unsupported = mutableScene();
    const unsupportedArrow = unsupported.elements[8];
    if (unsupportedArrow?.kind !== "arrow") {
      throw new TypeError("Expected Arrow fixture.");
    }
    unsupported.elements[8] = {
      ...unsupportedArrow,
      geometry: {
        ...unsupportedArrow.geometry,
        start: {
          ...unsupportedArrow.geometry.start,
          attachment: {
            targetElementId: elementIdFor(10),
            portId: "axes:z-positive",
          },
        },
      },
    };
    expect(() => validateSerializedSceneStateV1(unsupported)).toThrow(/port/u);
  });
});

describe("scene attachment port validation", () => {
  it.each([
    [2, "area:north"],
    [2, "area:east"],
    [2, "area:south"],
    [2, "area:west"],
    [10, "axes:origin"],
    [10, "axes:x-positive"],
    [10, "axes:y-positive"],
    [11, "axes:z-positive"],
  ] satisfies readonly (readonly [number, ObjectPortIdV1])[])(
    "accepts target index %i with port %s",
    (targetIndex, portId) => {
      const scene = mutableScene();
      const arrow = scene.elements[8];
      const target = scene.elements[targetIndex];
      if (arrow?.kind !== "arrow" || target === undefined) {
        throw new TypeError("Expected port fixtures.");
      }
      scene.elements[8] = {
        ...arrow,
        geometry: {
          ...arrow.geometry,
          start: {
            ...arrow.geometry.start,
            attachment: { targetElementId: target.elementId, portId },
          },
        },
      };

      expect(() => validateSerializedSceneStateV1(scene)).not.toThrow();
    },
  );
});

describe("scene attachment fanout limits", () => {
  it("accepts 1,024 attached endpoints to one target and rejects 1,025", () => {
    const target = everyElementKind()[2];
    const arrow = everyElementKind()[8];
    if (target?.kind !== "rectangle" || arrow?.kind !== "arrow") {
      throw new TypeError("Expected attachment fixtures.");
    }
    const lines: SceneElementV1[] = [];
    for (let index = 1; index <= 513; index += 1) {
      const revision = index + 1;
      const attachment = {
        targetElementId: target.elementId,
        portId: "area:east" as const,
      };
      lines.push({
        ...arrow,
        elementId: elementIdFor(index + 20),
        geometryRevision: createGeometryRevision(revision),
        styleRevision: createStyleRevision(revision),
        bindingRevision: createBindingRevision(revision),
        geometry: {
          ...arrow.geometry,
          start: { ...arrow.geometry.start, attachment },
          end: {
            ...arrow.geometry.end,
            attachment: index <= 512 ? attachment : null,
          },
        },
      });
    }
    const scene = {
      revision: createSceneRevision(514),
      elements: [target, ...lines],
      objectOrder: [target, ...lines].map(({ elementId }) => elementId),
      groups: [],
      noteAppearance: completeScene().noteAppearance,
    };

    expect(() =>
      validateSerializedSceneStateV1({
        ...scene,
        elements: scene.elements.slice(0, -1),
        objectOrder: scene.objectOrder.slice(0, -1),
      }),
    ).not.toThrow();
    expect(() => validateSerializedSceneStateV1(scene)).toThrow(/fanout/u);
  });
});

describe("scene aggregate stroke limits", () => {
  it("accepts 500,000 stroke points and rejects 500,001", () => {
    const atLimit = [
      penWithPointCount(0, 200_000),
      penWithPointCount(1, 200_000),
      penWithPointCount(2, 100_000),
    ];
    const scene = {
      revision: createSceneRevision(3),
      elements: atLimit,
      objectOrder: atLimit.map(({ elementId }) => elementId),
      groups: [],
      noteAppearance: completeScene().noteAppearance,
    };

    expect(() => validateSerializedSceneStateV1(scene)).not.toThrow();
    const aboveLimit = [...atLimit];
    aboveLimit[2] = penWithPointCount(2, 100_001);
    const decodeSpy = vi.spyOn(deltaVarintCodec, "decodeDeltaVarintStroke");
    const materializeSpy = vi.spyOn(elementModel, "materializeSceneElementV1");
    try {
      expect(() =>
        validateSerializedSceneStateV1({
          ...scene,
          elements: aboveLimit,
        }),
      ).toThrow(/Aggregate stroke points/u);
      expect(decodeSpy).not.toHaveBeenCalled();
      expect(materializeSpy).not.toHaveBeenCalled();
    } finally {
      decodeSpy.mockRestore();
      materializeSpy.mockRestore();
    }
  });

  it("admits 100,000 raw records and rejects 100,001 before materialization", () => {
    const emptyRecord = Object.freeze({});
    const atLimit = Array(100_000).fill(emptyRecord) as readonly unknown[];
    const source = {
      revision: 0,
      elements: atLimit,
      objectOrder: [],
      groups: [],
      noteAppearance: completeScene().noteAppearance,
    };
    expect(() => validateSerializedSceneStateV1(source)).toThrow(
      /Element kind/u,
    );

    const materializeSpy = vi.spyOn(elementModel, "materializeSceneElementV1");
    try {
      expect(() =>
        validateSerializedSceneStateV1({
          ...source,
          elements: [...atLimit, emptyRecord],
        }),
      ).toThrow(/record count/u);
      expect(materializeSpy).not.toHaveBeenCalled();
    } finally {
      materializeSpy.mockRestore();
    }
  });
});

describe("standalone scene record validation", () => {
  it("validates standalone Group and note-appearance closed records", () => {
    expect(
      validateGroupRecordV1({
        groupId: groupIdFor(0),
        childIds: [elementIdFor(0), elementIdFor(1)],
        selectionRotationRadians: -Math.PI,
      }),
    ).toMatchObject({ selectionRotationRadians: -Math.PI });
    expect(() =>
      validateGroupRecordV1({
        groupId: groupIdFor(0),
        childIds: [elementIdFor(0), elementIdFor(1)],
        selectionRotationRadians: Math.PI,
      }),
    ).toThrow(/canonical/u);
    expect(
      validateNoteAppearanceV1({
        background: "none",
        horizontalSpacing: "compact",
        contrast: "high",
      }),
    ).toEqual({
      background: "none",
      horizontalSpacing: "compact",
      contrast: "high",
    });
    expect(() =>
      validateNoteAppearanceV1({
        background: "image",
        horizontalSpacing: "compact",
        contrast: "high",
      }),
    ).toThrow(/unsupported/u);
  });
});
