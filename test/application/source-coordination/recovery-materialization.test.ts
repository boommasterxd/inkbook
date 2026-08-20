import { describe, expect, it } from "vitest";

import {
  commandFailure,
  commandSuccess,
  createHostTransactionSequence,
  createSessionOrder,
  createSidecarRevision,
  createSourceGeneration,
  parseHostEffectId,
  parseRecoveryAttemptId,
  parseSha256Digest,
  parseSourceCheckpointId,
  parseViewId,
  type Sha256Digest,
} from "../../../src/application/note-session";
import type {
  HostRecordedDirectionAttemptV1,
  HostRecordedForwardAttemptV1,
  PreparedForwardAttemptV1,
} from "../../../src/application/recovery";
import {
  materializeRecoveryHistory,
  type RecoveryPatchMaterializationWorkV1,
} from "../../../src/application/source-coordination/recovery-materialization";
import type {
  SourceCheckpointOperationV1,
  SourceCheckpointRootV1,
} from "../../../src/application/source-coordination";
import {
  createSceneRevision,
  parseBlockFingerprintV1,
  type ElementBinding,
} from "../../../src/domain/model";
import {
  createHistoryEpoch,
  invertAnnotationPatchV1,
  parseHistoryEntryId,
  parseOperationId,
  type AnnotationPatchV1,
} from "../../../src/domain/operations";
import { elementIdFor } from "../../domain/model/support";

/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact session orders, source generations, and traversal counts define recovery boundaries. */

const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";
const IDENTIFIER_PAYLOAD_LENGTH = 26;
const DIGEST_HEX_LENGTH = 64;
const BASE_DIGEST = digest(1);
const BASE = Object.freeze({
  markdownPath: "notes/recovery.md",
  rawTextSha256: BASE_DIGEST,
  revision: createSidecarRevision(1),
  vaultRelativePath: "notes/recovery.inkbook.json",
});
const ROOT: SourceCheckpointRootV1 = Object.freeze({
  base: BASE,
  digest: BASE_DIGEST,
  generation: createSourceGeneration(1),
  utf16Length: 4,
});

function digest(value: number): Sha256Digest {
  return parseSha256Digest(value.toString(16).padStart(DIGEST_HEX_LENGTH, "0"));
}

function identifier(prefix: string, value: number): string {
  let remaining = value;
  let encoded = "";
  do {
    const digit = BASE32[remaining % BASE32.length];
    if (digit === undefined) throw new RangeError("Invalid Base32 fixture.");
    encoded = `${digit}${encoded}`;
    remaining = Math.floor(remaining / BASE32.length);
  } while (remaining > 0);
  return `${prefix}_0${encoded.padStart(IDENTIFIER_PAYLOAD_LENGTH - 1, "0")}`;
}

function checkpoint(
  priorGeneration: number,
  sessionOrder: number,
): SourceCheckpointOperationV1 {
  return Object.freeze({
    base: BASE,
    checkpointId: parseSourceCheckpointId(identifier("scp", priorGeneration)),
    offsetMap: Object.freeze({ spans: Object.freeze([]) }),
    priorDigest: digest(priorGeneration),
    priorGeneration: createSourceGeneration(priorGeneration),
    priorUtf16Length: 4,
    replacementDigest: digest(priorGeneration + 1),
    replacementGeneration: createSourceGeneration(priorGeneration + 1),
    replacementUtf16Length: 4,
    sessionOrder: createSessionOrder(sessionOrder),
  });
}

function textBinding(utf16Offset: number): ElementBinding {
  return Object.freeze({
    anchor: Object.freeze({
      association: "after" as const,
      blockFingerprint: parseBlockFingerprintV1("a".repeat(DIGEST_HEX_LENGTH)),
      blockKind: "paragraph" as const,
      contextAfter: "after",
      contextBefore: "before",
      utf16Offset,
    }),
    confidence: "high" as const,
    inferenceProfileVersion: 1 as const,
    kind: "text-position" as const,
    localOffsetX: 0,
    localOffsetY: 0,
    origin: "manual" as const,
  });
}

function bindingPatch(offset: number): AnnotationPatchV1 {
  return Object.freeze({
    changes: Object.freeze([
      Object.freeze({
        elementId: elementIdFor(1),
        prior: textBinding(offset),
        replacement: textBinding(offset + 1),
      }),
    ]),
    kind: "replace-binding" as const,
  });
}

function hostAttempt(
  number: number,
  sessionOrder: number,
  sourceGeneration: number,
): HostRecordedForwardAttemptV1 {
  const forward = bindingPatch(1);
  return Object.freeze({
    acknowledgement: Object.freeze({
      direction: "forward" as const,
      editorViewId: parseViewId(`editor_${String(number)}`),
      effectId: parseHostEffectId(identifier("eff", number)),
      transactionSequence: createHostTransactionSequence(1),
    }),
    attemptId: parseRecoveryAttemptId(identifier("ra", number)),
    base: BASE,
    expectedSceneRevision: createSceneRevision(0),
    expectedSourceDigest: digest(sourceGeneration),
    expectedSourceGeneration: createSourceGeneration(sourceGeneration),
    forward,
    historyEntryId: parseHistoryEntryId(identifier("he", number)),
    historyEpoch: createHistoryEpoch(1),
    inverse: invertAnnotationPatchV1(forward),
    kind: "host-recorded-forward" as const,
    operationId: parseOperationId(identifier("op", number)),
    sessionOrder: createSessionOrder(sessionOrder),
  });
}

function preparedAttempt(
  number: number,
  sessionOrder: number,
): PreparedForwardAttemptV1 {
  const host = hostAttempt(number, sessionOrder, 1);
  return Object.freeze({
    attemptId: host.attemptId,
    base: host.base,
    expectedSceneRevision: host.expectedSceneRevision,
    expectedSourceDigest: host.expectedSourceDigest,
    expectedSourceGeneration: host.expectedSourceGeneration,
    forward: host.forward,
    historyEntryId: host.historyEntryId,
    historyEpoch: host.historyEpoch,
    inverse: host.inverse,
    kind: "prepared-forward" as const,
    operationId: host.operationId,
    sessionOrder: host.sessionOrder,
  });
}

function directionAttempt(
  number: number,
  sessionOrder: number,
  sourceGeneration: number,
): HostRecordedDirectionAttemptV1 {
  const host = hostAttempt(number, sessionOrder, sourceGeneration);
  return Object.freeze({
    acknowledgement: Object.freeze({
      ...host.acknowledgement,
      direction: "inverse" as const,
    }),
    attemptId: host.attemptId,
    base: host.base,
    directionPatch: host.inverse,
    expectedSceneRevision: host.expectedSceneRevision,
    expectedSourceDigest: host.expectedSourceDigest,
    expectedSourceGeneration: host.expectedSourceGeneration,
    historyEntryId: host.historyEntryId,
    historyEpoch: host.historyEpoch,
    kind: "host-recorded-undo" as const,
    operationId: host.operationId,
    sessionOrder: host.sessionOrder,
  });
}

function mappedPatch(
  work: RecoveryPatchMaterializationWorkV1,
): ReturnType<typeof commandSuccess<AnnotationPatchV1>> {
  if (work.patch.kind !== "replace-binding") {
    return commandSuccess(work.patch);
  }
  const changes = work.patch.changes.map((change) => {
    if (
      change.prior.kind !== "text-position" ||
      change.replacement.kind !== "text-position"
    ) {
      return change;
    }
    return {
      ...change,
      prior: textBinding(change.prior.anchor.utf16Offset + 1),
      replacement: textBinding(change.replacement.anchor.utf16Offset + 1),
    };
  });
  return commandSuccess({ kind: "replace-binding", changes });
}

function replacementOffset(attempt: HostRecordedForwardAttemptV1): number {
  if (attempt.forward.kind !== "replace-binding") {
    throw new Error("Expected a binding replacement fixture.");
  }
  const replacement = attempt.forward.changes[0]?.replacement;
  if (replacement?.kind !== "text-position") {
    throw new Error("Expected a text-position fixture.");
  }
  return replacement.anchor.utf16Offset;
}

function target(checkpoints: readonly SourceCheckpointOperationV1[]): {
  readonly digest: Sha256Digest;
  readonly utf16Length: number;
} {
  const last = checkpoints.at(-1);
  return last === undefined
    ? { digest: ROOT.digest, utf16Length: ROOT.utf16Length }
    : {
        digest: last.replacementDigest,
        utf16Length: last.replacementUtf16Length,
      };
}

describe("recovery history replay", () => {
  it("merges total order and rebases host attempts through each later checkpoint", () => {
    const first = hostAttempt(1, 1, 1);
    const prepared = preparedAttempt(2, 2);
    const second = hostAttempt(3, 4, 2);
    const calls: string[] = [];
    const checkpoints = [checkpoint(1, 3), checkpoint(2, 5)];
    const result = materializeRecoveryHistory({
      attempts: [second, prepared, first],
      checkpoints,
      materializePatch: (work) => {
        calls.push(
          `${work.role}:${String(work.checkpoint.replacementGeneration)}`,
        );
        return mappedPatch(work);
      },
      root: ROOT,
      target: target(checkpoints),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map(({ attempt }) => attempt.attemptId)).toEqual([
      first.attemptId,
      second.attemptId,
    ]);
    expect(result.value.map(({ traversedNodes }) => traversedNodes)).toEqual([
      2, 1,
    ]);
    expect(
      result.value.map(({ attempt }) =>
        replacementOffset(attempt as HostRecordedForwardAttemptV1),
      ),
    ).toEqual([4, 3]);
    expect(calls).toEqual([
      "forward:2",
      "forward:3",
      "inverse:2",
      "inverse:3",
      "forward:3",
      "inverse:3",
    ]);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value[0]?.attempt)).toBe(true);
    const replay = result.value[0]?.attempt;
    expect(
      replay?.kind === "host-recorded-forward" &&
        Object.isFrozen(replay.forward),
    ).toBe(true);
  });

  it("rejects a gap in the supplied checkpoint chain", () => {
    const checkpoints = [
      checkpoint(1, 2),
      { ...checkpoint(2, 3), priorGeneration: createSourceGeneration(3) },
    ];
    const result = materializeRecoveryHistory({
      attempts: [hostAttempt(1, 1, 1)],
      checkpoints,
      materializePatch: mappedPatch,
      root: ROOT,
      target: target(checkpoints),
    });
    expect(result).toEqual({ ok: false, code: "recovery-unavailable" });
  });
});

describe("recovery history materialization boundaries", () => {
  it("materializes a recorded direction and preserves the root target", () => {
    const attempt = directionAttempt(1, 1, 1);
    const result = materializeRecoveryHistory({
      attempts: [attempt],
      checkpoints: [],
      materializePatch: mappedPatch,
      root: ROOT,
      target: target([]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]).toMatchObject({
      sourceDigest: ROOT.digest,
      sourceGeneration: ROOT.generation,
      traversedNodes: 0,
      utf16Length: ROOT.utf16Length,
    });
    expect(result.value[0]?.attempt.kind).toBe("host-recorded-undo");
  });

  it("rejects duplicate total session order before materialization", () => {
    let calls = 0;
    const checkpoints = [checkpoint(1, 2)];
    const result = materializeRecoveryHistory({
      attempts: [hostAttempt(1, 2, 1)],
      checkpoints,
      materializePatch: (work) => {
        calls += 1;
        return mappedPatch(work);
      },
      root: ROOT,
      target: target(checkpoints),
    });
    expect(result).toEqual({ ok: false, code: "recovery-unavailable" });
    expect(calls).toBe(0);
  });

  it("publishes nothing unless the selected chain matches the exact current target", () => {
    const checkpoints = [checkpoint(1, 2)];
    let calls = 0;
    const result = materializeRecoveryHistory({
      attempts: [hostAttempt(1, 1, 1)],
      checkpoints,
      materializePatch: (work) => {
        calls += 1;
        return mappedPatch(work);
      },
      root: ROOT,
      target: { digest: digest(99), utf16Length: 4 },
    });
    expect(result).toEqual({ ok: false, code: "recovery-unavailable" });
    expect(calls).toBe(0);
  });

  it("rejects an attempt that references a source node after its successor", () => {
    let calls = 0;
    const checkpoints = [checkpoint(1, 2)];
    const result = materializeRecoveryHistory({
      attempts: [hostAttempt(1, 3, 1)],
      checkpoints,
      materializePatch: (work) => {
        calls += 1;
        return mappedPatch(work);
      },
      root: ROOT,
      target: target(checkpoints),
    });
    expect(result).toEqual({ ok: false, code: "recovery-unavailable" });
    expect(calls).toBe(0);
  });

  it("rejects a mismatched sidecar base and a materializer failure", () => {
    const mismatched = {
      ...hostAttempt(1, 1, 1),
      base: { ...BASE, markdownPath: "notes/other.md" },
    };
    expect(
      materializeRecoveryHistory({
        attempts: [mismatched],
        checkpoints: [],
        materializePatch: mappedPatch,
        root: ROOT,
        target: target([]),
      }),
    ).toEqual({ ok: false, code: "recovery-unavailable" });

    expect(
      materializeRecoveryHistory({
        attempts: [hostAttempt(2, 1, 1)],
        checkpoints: [checkpoint(1, 2)],
        materializePatch: () => commandFailure("stale-source"),
        root: ROOT,
        target: target([checkpoint(1, 2)]),
      }),
    ).toEqual({ ok: false, code: "recovery-unavailable" });
  });
});

describe("recovery history traversal limits", () => {
  it("rejects a materialization that would traverse 33 source nodes", () => {
    const checkpoints = Array.from({ length: 33 }, (_, index) =>
      checkpoint(index + 1, index + 2),
    );
    let calls = 0;
    const result = materializeRecoveryHistory({
      attempts: [hostAttempt(1, 1, 1)],
      checkpoints,
      materializePatch: (work) => {
        calls += 1;
        return mappedPatch(work);
      },
      root: ROOT,
      target: target(checkpoints),
    });
    expect(result).toEqual({ ok: false, code: "recovery-unavailable" });
    expect(calls).toBe(0);
  });

  it("publishes no partial replay when a later patch rebase is unsafe", () => {
    let calls = 0;
    const checkpoints = [checkpoint(1, 2), checkpoint(2, 3)];
    const result = materializeRecoveryHistory({
      attempts: [hostAttempt(1, 1, 1)],
      checkpoints,
      materializePatch: (work) => {
        calls += 1;
        if (calls === 2) {
          return commandSuccess({ kind: "replace-binding", changes: [] });
        }
        return mappedPatch(work);
      },
      root: ROOT,
      target: target(checkpoints),
    });
    expect(result).toEqual({ ok: false, code: "recovery-unavailable" });
    expect(calls).toBe(2);
  });
});
