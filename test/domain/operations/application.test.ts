/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact operation fixtures exercise generation boundaries. */
import { expect, it } from "vitest";

import {
  createSceneRevision,
  parseGroupId,
  type ElementId,
} from "../../../src/domain/model";
import type { AnnotationPatchV1 } from "../../../src/domain/operations";
import {
  applyAnnotationOperationV1,
  createAnnotationDependencyIndexV1,
  invertAnnotationPatchV1,
  type AnnotationDependencyIndexV1,
  type AnnotationOperationResultV1,
} from "../../../src/domain/operations";
import { replaceAnnotationElementV1 } from "../../../src/domain/operations/dependency-index";
import {
  createRuntimeSceneStateV1,
  type RuntimeSceneStateV1,
} from "../../../src/domain/scene";
import {
  elementIdFor,
  fixedBinding,
  NOTE_APPEARANCE,
  operation,
  rectangle,
  scene,
  valueOf,
} from "./support";

function apply(patch: AnnotationPatchV1): {
  readonly initial: RuntimeSceneStateV1;
  readonly indexed: AnnotationDependencyIndexV1;
  readonly result: AnnotationOperationResultV1;
} {
  const initial = scene([rectangle(0), rectangle(1), rectangle(2)]);
  const indexed = createAnnotationDependencyIndexV1(initial);
  expect(indexed.ok).toBe(true);
  if (!indexed.ok) throw new Error("Invalid fixture");
  return {
    initial,
    indexed: indexed.value,
    result: applyAnnotationOperationV1(
      initial,
      indexed.value,
      operation(patch),
    ),
  };
}

it.each([
  {
    name: "geometry",
    patch: {
      kind: "replace-geometry",
      changes: [
        {
          elementId: elementIdFor(1),
          prior: rectangle(1).geometry,
          replacement: { ...rectangle(1).geometry, width: 2 },
        },
      ],
    } satisfies AnnotationPatchV1,
    component: "geometryRevision" as const,
  },
  {
    name: "style",
    patch: {
      kind: "replace-style",
      changes: [
        {
          elementId: elementIdFor(1),
          prior: rectangle(1).style,
          replacement: { ...rectangle(1).style, width: 2 },
        },
      ],
    } satisfies AnnotationPatchV1,
    component: "styleRevision" as const,
  },
  {
    name: "binding",
    patch: {
      kind: "replace-binding",
      changes: [
        {
          elementId: elementIdFor(1),
          prior: fixedBinding(1),
          replacement: fixedBinding(5),
        },
      ],
    } satisfies AnnotationPatchV1,
    component: "bindingRevision" as const,
  },
])(
  "applies a $name replacement and advances only its component generation",
  ({ patch, component }) => {
    const { initial, result } = apply(patch);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const changed = result.value.scene.elementsById.get(elementIdFor(1));
    const unchanged = result.value.scene.elementsById.get(elementIdFor(0));
    expect(result.value.scene.revision).toBe(1);
    expect(changed?.[component]).toBe(1);
    expect(unchanged).toBe(initial.elementsById.get(elementIdFor(0)));
    for (const candidate of [
      "geometryRevision",
      "styleRevision",
      "bindingRevision",
    ] as const) {
      expect(changed?.[candidate]).toBe(candidate === component ? 1 : 0);
    }
  },
);

it("applies Create and exact inverse Delete with monotonic recreation revisions", () => {
  const initial = scene([]);
  const indexed = createAnnotationDependencyIndexV1(initial);
  expect(indexed.ok).toBe(true);
  if (!indexed.ok) return;
  const createdValue = valueOf(rectangle(4));
  const forward: AnnotationPatchV1 = {
    kind: "create-elements",
    elements: [createdValue],
    placement: {
      movedElementIds: [createdValue.elementId],
      predecessorId: null,
      successorId: null,
    },
  };
  const created = applyAnnotationOperationV1(
    initial,
    indexed.value,
    operation(forward),
  );
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  const deleted = applyAnnotationOperationV1(
    created.value.scene,
    created.value.dependencies,
    operation(invertAnnotationPatchV1(forward), 1, "1"),
  );
  expect(deleted.ok).toBe(true);
  if (!deleted.ok) return;
  const recreated = applyAnnotationOperationV1(
    deleted.value.scene,
    deleted.value.dependencies,
    operation(forward, 2, "2"),
  );

  expect(recreated.ok).toBe(true);
  if (!recreated.ok) return;
  expect(recreated.value.scene.revision).toBe(3);
  expect(
    recreated.value.scene.elementsById.get(createdValue.elementId),
  ).toMatchObject({
    geometryRevision: 3,
    styleRevision: 3,
    bindingRevision: 3,
  });
});

it("moves only the declared contiguous block between adjacent anchors", () => {
  const patch: AnnotationPatchV1 = {
    kind: "replace-object-order",
    prior: {
      movedElementIds: [elementIdFor(0)],
      predecessorId: null,
      successorId: elementIdFor(1),
    },
    replacement: {
      movedElementIds: [elementIdFor(0)],
      predecessorId: elementIdFor(2),
      successorId: null,
    },
  };
  const { result } = apply(patch);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(
    Array.from({ length: result.value.scene.objectOrder.length }, (_, index) =>
      result.value.scene.objectOrder.get(index),
    ),
  ).toEqual([elementIdFor(1), elementIdFor(2), elementIdFor(0)]);
});

it("rejects stale, prior-mismatched, overflowing, and partially invalid batches without mutation", () => {
  const valid: AnnotationPatchV1 = {
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
  };
  const initial = scene([rectangle(0)]);
  const indexed = createAnnotationDependencyIndexV1(initial);
  expect(indexed.ok).toBe(true);
  if (!indexed.ok) return;
  expect(
    applyAnnotationOperationV1(initial, indexed.value, operation(valid, 1)).ok,
  ).toBe(false);
  const batch: AnnotationPatchV1 = {
    kind: "atomic-batch",
    operations: [
      valid,
      {
        kind: "replace-binding",
        changes: [
          {
            elementId: elementIdFor(0),
            prior: fixedBinding(999),
            replacement: fixedBinding(2),
          },
        ],
      },
    ],
  };
  const rejected = applyAnnotationOperationV1(
    initial,
    indexed.value,
    operation(batch),
  );
  expect(rejected).toEqual({ ok: false, code: "invalid-operation" });
  expect(initial.revision).toBe(0);
  expect(initial.noteAppearance.background).toBe("none");
});

it("rejects duplicate component slots across an atomic batch", () => {
  const prior = rectangle(0).geometry;
  const patch: AnnotationPatchV1 = {
    kind: "atomic-batch",
    operations: [
      {
        kind: "replace-geometry",
        changes: [
          {
            elementId: elementIdFor(0),
            prior,
            replacement: { ...prior, width: 2 },
          },
        ],
      },
      {
        kind: "replace-geometry",
        changes: [
          {
            elementId: elementIdFor(0),
            prior: { ...prior, width: 2 },
            replacement: { ...prior, width: 3 },
          },
        ],
      },
    ],
  };
  expect(apply(patch).result).toEqual({
    ok: false,
    code: "invalid-operation",
  });
});

it("applies appearance replacement and its inverse at monotonic revisions", () => {
  const patch: AnnotationPatchV1 = {
    kind: "replace-note-appearance",
    prior: {
      background: "none",
      horizontalSpacing: "standard",
      contrast: "medium",
    },
    replacement: {
      background: "ruled",
      horizontalSpacing: "compact",
      contrast: "high",
    },
  };
  const { result } = apply(patch);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const restored = applyAnnotationOperationV1(
    result.value.scene,
    result.value.dependencies,
    operation(invertAnnotationPatchV1(patch), 1, "1"),
  );
  expect(restored.ok).toBe(true);
  if (!restored.ok) return;
  expect(restored.value.scene.revision).toBe(2);
  expect(restored.value.scene.noteAppearance).toEqual(patch.prior);
});

it("rejects revision exhaustion before publication", () => {
  const exhausted = createRuntimeSceneStateV1({
    revision: createSceneRevision(Number.MAX_SAFE_INTEGER),
    elements: [],
    objectOrder: [],
    groups: [],
    noteAppearance: {
      background: "none",
      horizontalSpacing: "standard",
      contrast: "medium",
    },
  });
  const indexed = createAnnotationDependencyIndexV1(exhausted);
  expect(indexed.ok).toBe(true);
  if (!indexed.ok) return;
  const patch: AnnotationPatchV1 = {
    kind: "replace-note-appearance",
    prior: exhausted.noteAppearance,
    replacement: { ...exhausted.noteAppearance, background: "dotted" },
  };
  expect(
    applyAnnotationOperationV1(
      exhausted,
      indexed.value,
      operation(patch, Number.MAX_SAFE_INTEGER),
    ),
  ).toEqual({ ok: false, code: "resource-limit" });
});

it("rejects foreign and stale dependency indices by Scene identity", () => {
  const initial = scene([rectangle(0)]);
  const structurallyEqual = scene([rectangle(0)]);
  const indexed = createAnnotationDependencyIndexV1(initial);
  expect(indexed.ok).toBe(true);
  if (!indexed.ok) return;
  const patch: AnnotationPatchV1 = {
    kind: "replace-note-appearance",
    prior: initial.noteAppearance,
    replacement: { ...initial.noteAppearance, background: "dotted" },
  };
  expect(
    applyAnnotationOperationV1(
      structurallyEqual,
      indexed.value,
      operation(patch),
    ),
  ).toEqual({ ok: false, code: "invalid-operation" });
  expect("replaceElement" in indexed.value).toBe(false);
  expect("replaceGroups" in indexed.value).toBe(false);
  expect("withObjectOrder" in indexed.value).toBe(false);
  expect("publishScene" in indexed.value).toBe(false);
  const staged = replaceAnnotationElementV1(
    indexed.value,
    initial.elementsById.get(elementIdFor(0)) ?? null,
    null,
  );
  expect(staged.ok).toBe(true);
  if (!staged.ok) return;
  expect(
    applyAnnotationOperationV1(initial, staged.value, operation(patch)),
  ).toEqual({ ok: false, code: "invalid-operation" });

  const published = applyAnnotationOperationV1(
    initial,
    indexed.value,
    operation(patch),
  );
  expect(published.ok).toBe(true);
  if (!published.ok) return;
  const undoOperation = operation(invertAnnotationPatchV1(patch), 1, "1");
  expect(
    applyAnnotationOperationV1(
      published.value.scene,
      indexed.value,
      undoOperation,
    ),
  ).toEqual({ ok: false, code: "invalid-operation" });
  expect(
    applyAnnotationOperationV1(
      published.value.scene,
      published.value.dependencies,
      undoOperation,
    ).ok,
  ).toBe(true);
});

it("rejects a same-size foreign index with different Group relations", () => {
  const elements = [rectangle(0), rectangle(1), rectangle(2)];
  const groupId = parseGroupId(`grp_${"0".repeat(26)}`);
  const groupedScene = (
    childIds: readonly [ElementId, ElementId],
  ): RuntimeSceneStateV1 =>
    createRuntimeSceneStateV1({
      revision: createSceneRevision(0),
      elements,
      objectOrder: elements.map(({ elementId }) => elementId),
      groups: [{ groupId, childIds, selectionRotationRadians: 0 }],
      noteAppearance: NOTE_APPEARANCE,
    });
  const indexedScene = groupedScene([elementIdFor(0), elementIdFor(1)]);
  const foreignScene = groupedScene([elementIdFor(1), elementIdFor(2)]);
  const indexed = createAnnotationDependencyIndexV1(indexedScene);
  expect(indexed.ok).toBe(true);
  if (!indexed.ok) return;
  const patch: AnnotationPatchV1 = {
    kind: "replace-note-appearance",
    prior: foreignScene.noteAppearance,
    replacement: { ...foreignScene.noteAppearance, background: "dotted" },
  };
  expect(
    applyAnnotationOperationV1(foreignScene, indexed.value, operation(patch)),
  ).toEqual({ ok: false, code: "invalid-operation" });
});
