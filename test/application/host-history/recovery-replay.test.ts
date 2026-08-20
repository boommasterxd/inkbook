/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact durable orders, revisions, epochs, and sequences define replay behavior. */
import { describe, expect, it } from "vitest";

import {
  replayMaterializedRecoveryHistory,
  type ReplayMaterializedRecoveryHistoryRequestV1,
} from "../../../src/application/host-history";
import {
  DEFAULT_HOST_HISTORY_LIMITS,
  isValidSnapshot,
} from "../../../src/application/host-history/validation";
import {
  createHostTransactionSequence,
  createSessionOrder,
  createSourceGeneration,
  parseHostEffectId,
  parseRecoveryAttemptId,
  parseSha256Digest,
  parseViewId,
} from "../../../src/application/note-session";
import type {
  HostRecordedDirectionAttemptV1,
  HostRecordedForwardAttemptV1,
} from "../../../src/application/recovery";
import type { MaterializedRecoveryReplayV1 } from "../../../src/application/source-coordination";
import { createSceneRevision } from "../../../src/domain/model";
import {
  createAnnotationHistoryEntryV1,
  createHistoryEpoch,
  parseHistoryEntryId,
  parseOperationId,
  type AnnotationPatchV1,
} from "../../../src/domain/operations";
import {
  createRuntimeSceneStateV1,
  type NoteAppearanceV1,
  type RuntimeSceneStateV1,
} from "../../../src/domain/scene";

const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";
const IDENTIFIER_PAYLOAD_LENGTH = 26;
const DIGEST = parseSha256Digest("0".repeat(64));
const EDITOR_A = parseViewId("editor_a");
const EDITOR_B = parseViewId("editor_b");
const NOTE = Object.freeze({
  vaultIdHint: "vault",
  vaultRelativeMarkdownPath: "Notes/recovery.md",
});
const NONE = Object.freeze({
  background: "none" as const,
  contrast: "medium" as const,
  horizontalSpacing: "standard" as const,
});
const RULED = Object.freeze({ ...NONE, background: "ruled" as const });
const SQUARED = Object.freeze({ ...NONE, background: "squared" as const });

describe("materialized host-history recovery replay", () => {
  it("replays a durable forward and reconstructs its actionable entry", () => {
    const forward = forwardReplay(1, 1, 0, 1, NONE, RULED);
    const result = replay([forward]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        acceptedDeliveries: [{ sequence: 1 }],
        entries: [{ lifecycle: "applied" }],
        highWaterMarks: [{ sequence: 1 }],
        lease: { epoch: 1, kind: "owned", ownerViewId: EDITOR_A },
        nextEpoch: 2,
        scene: { noteAppearance: RULED, revision: 1 },
      },
    });
    if (!result.ok) throw new Error("Expected replay success.");
    expect(
      isValidSnapshot(result.value, NOTE, DEFAULT_HOST_HISTORY_LIMITS),
    ).toBe(true);
  });

  it("replays a durable undo and retains an undone actionable entry", () => {
    const forward = forwardReplay(1, 1, 0, 1, NONE, RULED);
    const undo = directionReplay(forward, "undo", 2, 2, 1, 2);
    expect(replay([undo, forward])).toMatchObject({
      ok: true,
      value: {
        entries: [{ lifecycle: "undone" }],
        scene: { noteAppearance: NONE, revision: 2 },
      },
    });
  });

  it("replays forward, undo, and redo in total SessionOrder", () => {
    const forward = forwardReplay(1, 1, 0, 1, NONE, RULED);
    const undo = directionReplay(forward, "undo", 2, 2, 1, 2);
    const redo = directionReplay(forward, "redo", 3, 3, 2, 3);
    expect(replay([redo, forward, undo])).toMatchObject({
      ok: true,
      value: {
        acceptedDeliveries: [{ sequence: 3 }],
        entries: [{ lifecycle: "applied" }],
        highWaterMarks: [{ sequence: 3 }],
        scene: { noteAppearance: RULED, revision: 3 },
      },
    });
  });

  it("releases an undone redo branch when a later forward is accepted", () => {
    const first = forwardReplay(1, 1, 0, 1, NONE, RULED);
    const undo = directionReplay(first, "undo", 2, 2, 1, 2);
    const branch = forwardReplay(3, 3, 2, 3, NONE, SQUARED);
    const result = replay([branch, undo, first]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        entries: [
          {
            effectId: branch.attempt.acknowledgement.effectId,
            lifecycle: "applied",
          },
        ],
        scene: { noteAppearance: SQUARED, revision: 3 },
      },
    });
  });
});

describe("materialized host-history replay validation", () => {
  it("keeps the latest delivery per editor and epoch and rejects duplicate sequence order", () => {
    const first = forwardReplay(1, 1, 0, 1, NONE, RULED);
    const second = forwardReplay(2, 2, 1, 2, RULED, SQUARED);
    const result = replay([second, first]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        acceptedDeliveries: [
          {
            envelope: { effectId: second.attempt.acknowledgement.effectId },
            sequence: 2,
          },
        ],
        entries: [{ lifecycle: "applied" }, { lifecycle: "applied" }],
        highWaterMarks: [{ sequence: 2 }],
      },
    });

    const duplicate = withSequence(second, 1);
    expect(replay([first, duplicate])).toEqual({
      ok: false,
      code: "recovery-unavailable",
    });
  });

  it("orders high-water independently for duplicate editor and epoch keys", () => {
    const forward = forwardReplay(1, 1, 0, 1, NONE, RULED);
    const undo = withDirectionEditor(
      directionReplay(forward, "undo", 2, 2, 1, 1),
      EDITOR_B,
    );
    expect(replay([undo, forward])).toMatchObject({
      ok: true,
      value: {
        acceptedDeliveries: [
          { editorViewId: EDITOR_A, sequence: 1 },
          { editorViewId: EDITOR_B, sequence: 1 },
        ],
        highWaterMarks: [
          { editorViewId: EDITOR_A, sequence: 1 },
          { editorViewId: EDITOR_B, sequence: 1 },
        ],
      },
    });
  });
});

describe("materialized host-history replay failures", () => {
  it("fails closed for a stale root-scene revision", () => {
    const stale = forwardReplay(1, 1, 1, 1, NONE, RULED);
    expect(replay([stale])).toEqual({
      ok: false,
      code: "recovery-unavailable",
    });
  });

  it("fails closed for an invalid materialized patch", () => {
    const forward = forwardReplay(1, 1, 0, 1, NONE, RULED);
    const invalid = Object.freeze({
      ...forward,
      attempt: Object.freeze({
        ...forward.attempt,
        forward: Object.freeze({ kind: "unknown-patch" }),
      }),
    }) as unknown as MaterializedRecoveryReplayV1;
    expect(replay([invalid])).toEqual({
      ok: false,
      code: "recovery-unavailable",
    });
  });

  it("rejects a valid direction patch that does not match its history entry", () => {
    const forward = forwardReplay(1, 1, 0, 1, NONE, RULED);
    const undo = directionReplay(forward, "undo", 2, 2, 1, 2);
    const mismatched = Object.freeze({
      ...undo,
      attempt: Object.freeze({
        ...undo.attempt,
        directionPatch: Object.freeze({
          kind: "replace-note-appearance",
          prior: RULED,
          replacement: SQUARED,
        }),
      }),
    }) as MaterializedRecoveryReplayV1;
    expect(replay([forward, mismatched])).toEqual({
      ok: false,
      code: "recovery-unavailable",
    });
  });

  it("replays the exact scene but drops actionable history when effects are unreachable", () => {
    const forward = forwardReplay(1, 1, 0, 1, NONE, RULED);
    const result = replay([forward], false);
    expect(result).toMatchObject({
      ok: true,
      value: {
        acceptedDeliveries: [],
        entries: [],
        highWaterMarks: [],
        lease: { kind: "unowned" },
        scene: { noteAppearance: RULED, revision: 1 },
      },
    });
  });

  it("rejects replay above the bounded per-note recovery-record limit", () => {
    const forward = forwardReplay(1, 1, 0, 1, NONE, RULED);
    expect(replay(Array.from({ length: 4097 }, () => forward))).toEqual({
      ok: false,
      code: "recovery-limit",
    });
  });
});

describe("materialized host-history replay identity and lease failures", () => {
  it("rejects duplicate durable order, attempt, and operation identities", () => {
    const first = forwardReplay(1, 1, 0, 1, NONE, RULED);
    const second = forwardReplay(2, 2, 1, 2, RULED, SQUARED);
    const duplicates = [
      withAttempt(second, { sessionOrder: first.attempt.sessionOrder }),
      withAttempt(second, { attemptId: first.attempt.attemptId }),
      withAttempt(second, { operationId: first.attempt.operationId }),
    ];

    for (const duplicate of duplicates) {
      expect(replay([first, duplicate])).toEqual({
        code: "recovery-unavailable",
        ok: false,
      });
    }
  });

  it("replaces a prior epoch and rejects stale or non-owner forwards", () => {
    const first = forwardReplay(1, 1, 0, 1, NONE, RULED);
    const nextEpoch = withEpoch(forwardReplay(2, 2, 1, 1, RULED, SQUARED), 2);
    expect(replay([first, nextEpoch])).toMatchObject({
      ok: true,
      value: {
        entries: [{ effectId: nextEpoch.attempt.acknowledgement.effectId }],
        lease: { epoch: 2, ownerViewId: EDITOR_A },
      },
    });

    const higher = withEpoch(forwardReplay(3, 1, 0, 1, NONE, RULED), 2);
    const stale = forwardReplay(4, 2, 1, 1, RULED, SQUARED);
    expect(replay([higher, stale])).toEqual({
      code: "recovery-unavailable",
      ok: false,
    });
    const nonOwner = withDirectionEditor(
      forwardReplay(5, 2, 1, 1, RULED, SQUARED),
      EDITOR_B,
    );
    expect(replay([first, nonOwner])).toEqual({
      code: "recovery-unavailable",
      ok: false,
    });
  });

  it("enforces the replay actionable-entry limit", () => {
    const first = forwardReplay(1, 1, 0, 1, NONE, RULED);
    const second = forwardReplay(2, 2, 1, 2, RULED, SQUARED);
    expect(replay([first, second], true, { maxActionableEntries: 1 })).toEqual({
      code: "recovery-limit",
      ok: false,
    });
  });
});

function replay(
  records: readonly MaterializedRecoveryReplayV1[],
  hostEffectsMayBeReachable = true,
  limits?: ReplayMaterializedRecoveryHistoryRequestV1["limits"],
): ReturnType<typeof replayMaterializedRecoveryHistory> {
  const request: ReplayMaterializedRecoveryHistoryRequestV1 = {
    hostEffectsMayBeReachable,
    ...(limits === undefined ? {} : { limits }),
    noteIdentity: NOTE,
    replay: records,
    sidecarRootScene: rootScene(),
  };
  return replayMaterializedRecoveryHistory(request);
}

function forwardReplay(
  id: number,
  sessionOrder: number,
  expectedSceneRevision: number,
  sequence: number,
  prior: NoteAppearanceV1,
  replacement: NoteAppearanceV1,
): MaterializedRecoveryReplayV1 & {
  readonly attempt: HostRecordedForwardAttemptV1;
} {
  const forward: AnnotationPatchV1 = Object.freeze({
    kind: "replace-note-appearance",
    prior,
    replacement,
  });
  const history = createAnnotationHistoryEntryV1({
    forward,
    historyEntryId: parseHistoryEntryId(identifier("he", id)),
    historyEpoch: createHistoryEpoch(1),
  });
  if (!history.ok) throw new Error("Expected a valid history fixture.");
  const attempt: HostRecordedForwardAttemptV1 = Object.freeze({
    acknowledgement: Object.freeze({
      direction: "forward",
      editorViewId: EDITOR_A,
      effectId: parseHostEffectId(identifier("eff", id)),
      transactionSequence: createHostTransactionSequence(sequence),
    }),
    attemptId: parseRecoveryAttemptId(identifier("ra", id)),
    base: Object.freeze({
      markdownPath: NOTE.vaultRelativeMarkdownPath,
      rawTextSha256: null,
      revision: null,
      vaultRelativePath: NOTE.vaultRelativeMarkdownPath,
    }),
    expectedSceneRevision: createSceneRevision(expectedSceneRevision),
    expectedSourceDigest: DIGEST,
    expectedSourceGeneration: createSourceGeneration(1),
    forward: history.value.forward,
    historyEntryId: history.value.historyEntryId,
    historyEpoch: history.value.historyEpoch,
    inverse: history.value.inverse,
    kind: "host-recorded-forward",
    operationId: parseOperationId(identifier("op", id)),
    sessionOrder: createSessionOrder(sessionOrder),
  });
  return materialized(attempt);
}

function directionReplay(
  forward: ReturnType<typeof forwardReplay>,
  direction: "undo" | "redo",
  id: number,
  sessionOrder: number,
  expectedSceneRevision: number,
  sequence: number,
): MaterializedRecoveryReplayV1 {
  const attempt: HostRecordedDirectionAttemptV1 = Object.freeze({
    acknowledgement: Object.freeze({
      direction: direction === "undo" ? "inverse" : "forward",
      editorViewId: EDITOR_A,
      effectId: forward.attempt.acknowledgement.effectId,
      transactionSequence: createHostTransactionSequence(sequence),
    }),
    attemptId: parseRecoveryAttemptId(identifier("ra", id)),
    base: forward.attempt.base,
    directionPatch:
      direction === "undo" ? forward.attempt.inverse : forward.attempt.forward,
    expectedSceneRevision: createSceneRevision(expectedSceneRevision),
    expectedSourceDigest: DIGEST,
    expectedSourceGeneration: createSourceGeneration(1),
    historyEntryId: forward.attempt.historyEntryId,
    historyEpoch: forward.attempt.historyEpoch,
    kind: direction === "undo" ? "host-recorded-undo" : "host-recorded-redo",
    operationId: parseOperationId(identifier("op", id)),
    sessionOrder: createSessionOrder(sessionOrder),
  });
  return materialized(attempt);
}

function materialized<
  T extends HostRecordedForwardAttemptV1 | HostRecordedDirectionAttemptV1,
>(attempt: T): MaterializedRecoveryReplayV1 & { readonly attempt: T } {
  return Object.freeze({
    attempt,
    sourceDigest: DIGEST,
    sourceGeneration: createSourceGeneration(1),
    traversedNodes: 0,
    utf16Length: 0,
  });
}

function withSequence(
  replay: ReturnType<typeof forwardReplay>,
  sequence: number,
): ReturnType<typeof forwardReplay> {
  return Object.freeze({
    ...replay,
    attempt: Object.freeze({
      ...replay.attempt,
      acknowledgement: Object.freeze({
        ...replay.attempt.acknowledgement,
        transactionSequence: createHostTransactionSequence(sequence),
      }),
    }),
  });
}

function withAttempt(
  replay: ReturnType<typeof forwardReplay>,
  replacement: Partial<HostRecordedForwardAttemptV1>,
): ReturnType<typeof forwardReplay> {
  return Object.freeze({
    ...replay,
    attempt: Object.freeze({ ...replay.attempt, ...replacement }),
  });
}

function withEpoch(
  replay: ReturnType<typeof forwardReplay>,
  epoch: number,
): ReturnType<typeof forwardReplay> {
  return withAttempt(replay, { historyEpoch: createHistoryEpoch(epoch) });
}

function withDirectionEditor(
  replay: MaterializedRecoveryReplayV1,
  editorViewId: typeof EDITOR_B,
): MaterializedRecoveryReplayV1 {
  return Object.freeze({
    ...replay,
    attempt: Object.freeze({
      ...replay.attempt,
      acknowledgement: Object.freeze({
        ...replay.attempt.acknowledgement,
        editorViewId,
      }),
    }),
  });
}

function rootScene(): RuntimeSceneStateV1 {
  return createRuntimeSceneStateV1({
    elements: [],
    groups: [],
    noteAppearance: NONE,
    objectOrder: [],
    revision: createSceneRevision(0),
  });
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
