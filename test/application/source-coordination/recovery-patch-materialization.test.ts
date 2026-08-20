import { describe, expect, it } from "vitest";

import {
  createSessionOrder,
  createSidecarRevision,
  createSourceGeneration,
  parseSha256Digest,
  parseSourceCheckpointId,
} from "../../../src/application/note-session";
import { materializeAnnotationPatchThroughOffsetMapV1 } from "../../../src/application/source-coordination/recovery-patch-materialization";
import type { RecoveryPatchMaterializationWorkV1 } from "../../../src/application/source-coordination/recovery-materialization";
import type {
  SourceCheckpointOperationV1,
  SourceOffsetMapV1,
} from "../../../src/application/source-coordination/types";
import type {
  ElementBinding,
  SceneElementValueV1,
} from "../../../src/domain/model";
import {
  validateAnnotationPatchV1,
  type AnnotationPatchV1,
} from "../../../src/domain/operations";
import {
  FIXED_BINDING,
  POSITION_BINDING,
  RANGE_BINDING,
  everyElementKind,
} from "../../domain/codecs/scene-support";

/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact offsets exercise association and collapse boundaries. */

const DIGEST = parseSha256Digest("a".repeat(64));
const INSERTION_MAP: SourceOffsetMapV1 = Object.freeze({
  spans: Object.freeze([
    Object.freeze({
      newFromUtf16: 2,
      newToUtf16: 3,
      oldFromUtf16: 2,
      oldToUtf16: 2,
    }),
  ]),
});

function checkpoint(
  offsetMap: SourceOffsetMapV1 = INSERTION_MAP,
  priorUtf16Length = 5,
  replacementUtf16Length = 6,
): SourceCheckpointOperationV1 {
  return Object.freeze({
    base: Object.freeze({
      markdownPath: "notes/recovery.md",
      rawTextSha256: DIGEST,
      revision: createSidecarRevision(1),
      vaultRelativePath: "notes/recovery.inkbook.json",
    }),
    checkpointId: parseSourceCheckpointId("scp_00000000000000000000000001"),
    offsetMap,
    priorDigest: DIGEST,
    priorGeneration: createSourceGeneration(1),
    priorUtf16Length,
    replacementDigest: parseSha256Digest("b".repeat(64)),
    replacementGeneration: createSourceGeneration(2),
    replacementUtf16Length,
    sessionOrder: createSessionOrder(1),
  });
}

function deletionCheckpoint(): SourceCheckpointOperationV1 {
  return checkpoint(
    Object.freeze({
      spans: Object.freeze([
        Object.freeze({
          newFromUtf16: 1,
          newToUtf16: 1,
          oldFromUtf16: 1,
          oldToUtf16: 3,
        }),
      ]),
    }),
    5,
    3,
  );
}

function work(
  patch: AnnotationPatchV1,
  sourceCheckpoint = checkpoint(),
): RecoveryPatchMaterializationWorkV1 {
  return Object.freeze({
    checkpoint: sourceCheckpoint,
    offsetMap: sourceCheckpoint.offsetMap,
    patch,
    role: "forward" as const,
    traversedNodes: 1,
  });
}

function canonical(patch: AnnotationPatchV1): AnnotationPatchV1 {
  const result = validateAnnotationPatchV1(patch);
  if (!result.ok) throw new Error("Expected a canonical patch fixture.");
  return result.value;
}

function position(
  utf16Offset: number,
  association: "before" | "after",
): ElementBinding {
  if (POSITION_BINDING.kind !== "text-position") {
    throw new Error("Expected a position binding fixture.");
  }
  return Object.freeze({
    ...POSITION_BINDING,
    anchor: Object.freeze({
      ...POSITION_BINDING.anchor,
      association,
      utf16Offset,
    }),
  });
}

function movedFixedBinding(): ElementBinding {
  if (FIXED_BINDING.kind !== "fixed") {
    throw new Error("Expected a fixed binding fixture.");
  }
  return Object.freeze({ ...FIXED_BINDING, anchorX: 1 });
}

function range(start: number, end: number): ElementBinding {
  if (RANGE_BINDING.kind !== "text-range") {
    throw new Error("Expected a range binding fixture.");
  }
  return Object.freeze({
    ...RANGE_BINDING,
    end: Object.freeze({
      ...RANGE_BINDING.end,
      association: "before" as const,
      utf16Offset: end,
    }),
    start: Object.freeze({
      ...RANGE_BINDING.start,
      association: "after" as const,
      utf16Offset: start,
    }),
  });
}

function elementValue(binding: ElementBinding): SceneElementValueV1 {
  const element = everyElementKind()[0];
  if (element === undefined) throw new Error("Expected an element fixture.");
  const value = { ...element } as Record<string, unknown>;
  delete value.bindingRevision;
  delete value.geometryRevision;
  delete value.styleRevision;
  return { ...value, binding } as SceneElementValueV1;
}

function mappedBinding(
  patch: AnnotationPatchV1,
  side: "prior" | "replacement",
): ElementBinding {
  if (patch.kind !== "replace-binding") {
    throw new Error("Expected a binding patch.");
  }
  const change = patch.changes[0];
  if (change === undefined) throw new Error("Expected a binding change.");
  return change[side];
}

describe("recovery patch source-bound binding materialization", () => {
  it("maps before and after associations independently", () => {
    const patch = canonical({
      changes: [
        {
          elementId: elementValue(FIXED_BINDING).elementId,
          prior: position(2, "before"),
          replacement: position(2, "after"),
        },
      ],
      kind: "replace-binding",
    });
    const result = materializeAnnotationPatchThroughOffsetMapV1(work(patch));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prior = mappedBinding(result.value, "prior");
    const replacement = mappedBinding(result.value, "replacement");
    expect(prior.kind === "text-position" && prior.anchor.utf16Offset).toBe(2);
    expect(
      replacement.kind === "text-position" && replacement.anchor.utf16Offset,
    ).toBe(3);
  });

  it.each(["create-elements", "delete-elements"] as const)(
    "maps position and range bindings inside %s values",
    (kind) => {
      const positionElement = elementValue(position(2, "after"));
      const rangeElement = {
        ...elementValue(range(2, 5)),
        elementId: everyElementKind()[1]?.elementId,
      } as SceneElementValueV1;
      const patch = canonical(
        kind === "create-elements"
          ? {
              elements: [positionElement, rangeElement],
              kind,
              placement: {
                movedElementIds: [
                  positionElement.elementId,
                  rangeElement.elementId,
                ],
                predecessorId: null,
                successorId: null,
              },
            }
          : {
              elements: [positionElement, rangeElement],
              kind,
              priorPlacement: {
                movedElementIds: [
                  positionElement.elementId,
                  rangeElement.elementId,
                ],
                predecessorId: null,
                successorId: null,
              },
            },
      );
      const result = materializeAnnotationPatchThroughOffsetMapV1(work(patch));
      expect(result.ok).toBe(true);
      if (
        !result.ok ||
        (result.value.kind !== "create-elements" &&
          result.value.kind !== "delete-elements")
      ) {
        return;
      }
      const first = result.value.elements[0]?.binding;
      const second = result.value.elements[1]?.binding;
      expect(first?.kind === "text-position" && first.anchor.utf16Offset).toBe(
        3,
      );
      expect(second?.kind === "text-range" && second.start.utf16Offset).toBe(3);
      expect(second?.kind === "text-range" && second.end.utf16Offset).toBe(6);
      expect(result.value.elements[0]?.geometry).toBe(
        patch.kind === "create-elements" || patch.kind === "delete-elements"
          ? patch.elements[0]?.geometry
          : undefined,
      );
    },
  );
});

describe("recovery patch atomic and identity materialization", () => {
  it("maps binding-bearing members inside an atomic batch", () => {
    const element = elementValue(position(2, "after"));
    const patch = canonical({
      kind: "atomic-batch",
      operations: [
        {
          elements: [element],
          kind: "create-elements",
          placement: {
            movedElementIds: [element.elementId],
            predecessorId: null,
            successorId: null,
          },
        },
        {
          changes: [
            {
              elementId: element.elementId,
              prior: position(2, "before"),
              replacement: position(2, "after"),
            },
          ],
          kind: "replace-binding",
        },
      ],
    });
    const result = materializeAnnotationPatchThroughOffsetMapV1(work(patch));
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "atomic-batch") return;
    expect(result.value.operations).toHaveLength(2);
    expect(Object.isFrozen(result.value.operations)).toBe(true);
  });

  it("preserves exact identity for fixed and identity-mapped bindings", () => {
    const fixed = canonical({
      changes: [
        {
          elementId: elementValue(FIXED_BINDING).elementId,
          prior: FIXED_BINDING,
          replacement: movedFixedBinding(),
        },
      ],
      kind: "replace-binding",
    });
    expect(materializeAnnotationPatchThroughOffsetMapV1(work(fixed))).toEqual({
      ok: true,
      value: fixed,
    });

    const positionPatch = canonical({
      changes: [
        {
          elementId: elementValue(FIXED_BINDING).elementId,
          prior: position(1, "before"),
          replacement: position(1, "after"),
        },
      ],
      kind: "replace-binding",
    });
    const identityCheckpoint = checkpoint(
      Object.freeze({ spans: Object.freeze([]) }),
      5,
      5,
    );
    const result = materializeAnnotationPatchThroughOffsetMapV1(
      work(positionPatch, identityCheckpoint),
    );
    expect(result.ok && result.value).toBe(positionPatch);
  });
});

describe("recovery patch normalization and sharing", () => {
  it("normalizes mutable input and shares source-independent members", () => {
    const element = elementValue(FIXED_BINDING);
    const mutable: AnnotationPatchV1 = {
      changes: [
        {
          elementId: element.elementId,
          prior: FIXED_BINDING,
          replacement: movedFixedBinding(),
        },
      ],
      kind: "replace-binding",
    };
    const normalized = materializeAnnotationPatchThroughOffsetMapV1(
      work(mutable),
    );
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value).not.toBe(mutable);
    expect(Object.isFrozen(normalized.value)).toBe(true);

    const fixedCreate = canonical({
      elements: [element],
      kind: "create-elements",
      placement: {
        movedElementIds: [element.elementId],
        predecessorId: null,
        successorId: null,
      },
    });
    expect(
      materializeAnnotationPatchThroughOffsetMapV1(work(fixedCreate)),
    ).toEqual({ ok: true, value: fixedCreate });

    const appearanceBatch = canonical({
      kind: "atomic-batch",
      operations: [
        {
          kind: "replace-note-appearance",
          prior: {
            background: "none",
            contrast: "medium",
            horizontalSpacing: "standard",
          },
          replacement: {
            background: "ruled",
            contrast: "high",
            horizontalSpacing: "wide",
          },
        },
      ],
    });
    expect(
      materializeAnnotationPatchThroughOffsetMapV1(work(appearanceBatch)),
    ).toEqual({ ok: true, value: appearanceBatch });
  });
});

describe("recovery patch materialization failures", () => {
  it("fails closed for collapsed, out-of-bounds, resource, and open inputs", () => {
    const elementId = elementValue(FIXED_BINDING).elementId;
    const collapsed = canonical({
      changes: [
        {
          elementId,
          prior: FIXED_BINDING,
          replacement: range(1, 3),
        },
      ],
      kind: "replace-binding",
    });
    const deletion = deletionCheckpoint();
    expect(
      materializeAnnotationPatchThroughOffsetMapV1(work(collapsed, deletion)),
    ).toEqual({ ok: false, code: "recovery-unavailable" });

    const outOfBounds = canonical({
      changes: [
        {
          elementId,
          prior: FIXED_BINDING,
          replacement: position(6, "after"),
        },
      ],
      kind: "replace-binding",
    });
    expect(
      materializeAnnotationPatchThroughOffsetMapV1(work(outOfBounds)),
    ).toEqual({ ok: false, code: "recovery-unavailable" });
    expect(
      materializeAnnotationPatchThroughOffsetMapV1(
        work(outOfBounds, checkpoint(INSERTION_MAP, -1, 6)),
      ),
    ).toEqual({ ok: false, code: "recovery-unavailable" });
    expect(
      materializeAnnotationPatchThroughOffsetMapV1(
        work({ ...outOfBounds, extra: true } as unknown as AnnotationPatchV1),
      ),
    ).toEqual({ ok: false, code: "recovery-unavailable" });
  });
});

describe("recovery patch boundary failures", () => {
  it("fails atomic, boundary-specific, and canonical-collapse mapping closed", () => {
    const firstId = elementValue(FIXED_BINDING).elementId;
    const secondId = everyElementKind()[1]?.elementId;
    if (secondId === undefined) throw new Error("Expected a second element.");
    const atomic = canonical({
      kind: "atomic-batch",
      operations: [
        {
          changes: [
            {
              elementId: firstId,
              prior: FIXED_BINDING,
              replacement: movedFixedBinding(),
            },
          ],
          kind: "replace-binding",
        },
        {
          changes: [
            {
              elementId: secondId,
              prior: FIXED_BINDING,
              replacement: position(6, "after"),
            },
          ],
          kind: "replace-binding",
        },
      ],
    });
    expect(materializeAnnotationPatchThroughOffsetMapV1(work(atomic))).toEqual({
      ok: false,
      code: "recovery-unavailable",
    });

    for (const binding of [range(6, 7), range(1, 6)]) {
      const boundary = canonical({
        changes: [
          { elementId: firstId, prior: FIXED_BINDING, replacement: binding },
        ],
        kind: "replace-binding",
      });
      expect(
        materializeAnnotationPatchThroughOffsetMapV1(work(boundary)),
      ).toEqual({ ok: false, code: "recovery-unavailable" });
    }

    const collapse = canonical({
      changes: [
        {
          elementId: firstId,
          prior: position(1, "after"),
          replacement: position(2, "after"),
        },
      ],
      kind: "replace-binding",
    });
    expect(
      materializeAnnotationPatchThroughOffsetMapV1(
        work(collapse, deletionCheckpoint()),
      ),
    ).toEqual({ ok: false, code: "recovery-unavailable" });
  });
});
