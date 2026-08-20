import { describe, expect, it } from "vitest";

import { encodeCanonicalJson } from "../../../src/domain/codecs/canonical-json";
import { createSceneRevision } from "../../../src/domain/model";
import {
  parseHistoryEntryId,
  parseOperationId,
  type AnnotationPatchV1,
} from "../../../src/domain/operations";
import {
  createHistoryEpoch,
  createHostTransactionSequence,
  createSessionOrder,
  createSettingsRevision,
  createSidecarRevision,
  createSourceGeneration,
  parseRecoveryAttemptId,
  parseHostEffectId,
  parseRelocationId,
  parseRemovalId,
  parseSha256Digest,
  parseSourceCheckpointId,
  parseViewId,
} from "../../../src/application/note-session";
import {
  decodeRecoveryRecordV1,
  encodeRecoveryRecordV1,
  type HostRecordedForwardAttemptV1,
  type PreparedForwardAttemptV1,
  type RecoveryPersistenceRecordV1,
} from "../../../src/application/recovery";

/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact persistence records exercise canonical numeric fields. */

const ID_PAYLOAD = "00000000000000000000000000";
const DIGEST_LENGTH = 64;
const DIGEST_A = parseSha256Digest("a".repeat(DIGEST_LENGTH));
const DIGEST_B = parseSha256Digest("b".repeat(DIGEST_LENGTH));
const BASE = Object.freeze({
  markdownPath: "notes/source.md",
  rawTextSha256: DIGEST_A,
  revision: createSidecarRevision(1),
  vaultRelativePath: "notes/source.inkbook.json",
});
const NOTE = Object.freeze({
  vaultIdHint: "vault",
  vaultRelativeMarkdownPath: "notes/source.md",
});
const FORWARD: AnnotationPatchV1 = Object.freeze({
  kind: "replace-note-appearance",
  prior: Object.freeze({
    background: "none",
    contrast: "medium",
    horizontalSpacing: "standard",
  }),
  replacement: Object.freeze({
    background: "ruled",
    contrast: "high",
    horizontalSpacing: "wide",
  }),
});
const INVERSE: AnnotationPatchV1 = Object.freeze({
  kind: "replace-note-appearance",
  prior: FORWARD.replacement,
  replacement: FORWARD.prior,
});

function attempt(): PreparedForwardAttemptV1 {
  return {
    attemptId: parseRecoveryAttemptId(`ra_${ID_PAYLOAD}`),
    base: BASE,
    expectedSceneRevision: createSceneRevision(1),
    expectedSourceDigest: DIGEST_A,
    expectedSourceGeneration: createSourceGeneration(1),
    forward: FORWARD,
    historyEntryId: parseHistoryEntryId(`he_${ID_PAYLOAD}`),
    historyEpoch: createHistoryEpoch(1),
    inverse: INVERSE,
    kind: "prepared-forward",
    operationId: parseOperationId(`op_${ID_PAYLOAD}`),
    sessionOrder: createSessionOrder(1),
  };
}

function historyRecords(
  prepared: PreparedForwardAttemptV1,
): readonly RecoveryPersistenceRecordV1[] {
  const acknowledgement = {
    direction: "forward" as const,
    editorViewId: parseViewId("view-a"),
    effectId: parseHostEffectId(`eff_${ID_PAYLOAD}`),
    transactionSequence: createHostTransactionSequence(1),
  };
  return [
    {
      ...prepared,
      acknowledgement,
      kind: "host-recorded-forward",
    },
    {
      acknowledgement: { ...acknowledgement, direction: "inverse" },
      attemptId: parseRecoveryAttemptId(`ra_00000000000000000000000001`),
      base: BASE,
      directionPatch: INVERSE,
      expectedSceneRevision: createSceneRevision(2),
      expectedSourceDigest: DIGEST_A,
      expectedSourceGeneration: createSourceGeneration(1),
      historyEntryId: prepared.historyEntryId,
      historyEpoch: prepared.historyEpoch,
      kind: "host-recorded-undo",
      operationId: parseOperationId(`op_00000000000000000000000001`),
      sessionOrder: createSessionOrder(2),
    },
    {
      acknowledgement,
      attemptId: parseRecoveryAttemptId(`ra_00000000000000000000000002`),
      base: BASE,
      directionPatch: FORWARD,
      expectedSceneRevision: createSceneRevision(3),
      expectedSourceDigest: DIGEST_A,
      expectedSourceGeneration: createSourceGeneration(1),
      historyEntryId: prepared.historyEntryId,
      historyEpoch: prepared.historyEpoch,
      kind: "host-recorded-redo",
      operationId: parseOperationId(`op_00000000000000000000000002`),
      sessionOrder: createSessionOrder(3),
    },
  ];
}

function forwardAttempts(): readonly [
  PreparedForwardAttemptV1,
  HostRecordedForwardAttemptV1,
] {
  const prepared = attempt();
  const recorded = historyRecords(prepared)[0];
  if (
    recorded === undefined ||
    !("kind" in recorded) ||
    recorded.kind !== "host-recorded-forward"
  ) {
    throw new Error("Missing host-recorded Forward fixture.");
  }
  return [prepared, recorded];
}

function records(): readonly RecoveryPersistenceRecordV1[] {
  const prepared = attempt();
  return [
    prepared,
    ...historyRecords(prepared),
    {
      base: BASE,
      checkpointId: parseSourceCheckpointId(`scp_${ID_PAYLOAD}`),
      offsetMap: {
        spans: [
          {
            newFromUtf16: 1,
            newToUtf16: 3,
            oldFromUtf16: 1,
            oldToUtf16: 2,
          },
        ],
      },
      priorDigest: DIGEST_A,
      priorGeneration: createSourceGeneration(1),
      priorUtf16Length: 4,
      replacementDigest: DIGEST_B,
      replacementGeneration: createSourceGeneration(2),
      replacementUtf16Length: 5,
      sessionOrder: createSessionOrder(2),
    },
    {
      destinationMarkdownPath: "notes/destination.md",
      destinationSidecarPath: "notes/destination.inkbook.json",
      expectedSceneRevision: createSceneRevision(1),
      expectedSettingsRevision: createSettingsRevision(1),
      kind: "markdown-file",
      noteIdentity: NOTE,
      relocationId: parseRelocationId(`rel_${ID_PAYLOAD}`),
      sidecarBase: BASE,
      sourceMarkdownPath: "notes/source.md",
      sourceSidecarPath: "notes/source.inkbook.json",
      step: "complete",
    },
    {
      admittedRecordCount: 2,
      cursor: 1,
      expectedSettingsRevision: createSettingsRevision(1),
      generation: 1,
      kind: "folder-prefix",
      priorPrefix: "notes/source",
      relocationId: parseRelocationId(`rel_${ID_PAYLOAD}`),
      replacementPrefix: "notes/destination",
      step: "processing",
    },
    {
      deadlineEpochMs: 1,
      deleteEventAcknowledged: true,
      expectedSceneRevision: createSceneRevision(1),
      kind: "annotation-removal",
      markerState: "removing",
      noteIdentity: NOTE,
      removalId: parseRemovalId(`rm_${ID_PAYLOAD}`),
      sidecarBase: BASE,
      trashAcknowledged: true,
    },
  ];
}

describe("recovery persistence record codec", () => {
  it.each(records())("round-trips canonical %s records exactly", (record) => {
    const encoded = encodeRecoveryRecordV1(record);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;

    const decoded = decodeRecoveryRecordV1(encoded.value);
    expect(decoded).toEqual({ ok: true, value: record });
    if (!decoded.ok) return;
    expect(Object.isFrozen(decoded.value)).toBe(true);
  });

  it("round-trips a host-recorded forward attempt exactly", () => {
    const record = historyRecords(attempt())[0];
    expect(record).toBeDefined();
    if (record === undefined) return;

    const encoded = encodeRecoveryRecordV1(record);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;

    expect(decodeRecoveryRecordV1(encoded.value)).toEqual({
      ok: true,
      value: record,
    });
  });

  it("rejects non-canonical key order and unknown fields", () => {
    const encoded = encodeRecoveryRecordV1(attempt());
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const canonical = new TextDecoder().decode(encoded.value);
    const reordered = canonical
      .replace('{"record":', '{"schemaVersion":1,"record":')
      .replace(',"schemaVersion":1}', "}");
    expect(decodeRecoveryRecordV1(new TextEncoder().encode(reordered))).toEqual(
      { ok: false, code: "invalid-command" },
    );

    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    parsed.unknown = true;
    expect(
      decodeRecoveryRecordV1(new TextEncoder().encode(JSON.stringify(parsed))),
    ).toEqual({ ok: false, code: "invalid-command" });
  });

  it("rejects duplicate keys before materialization", () => {
    const encoded = encodeRecoveryRecordV1(attempt());
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const canonical = new TextDecoder().decode(encoded.value);
    const duplicate = canonical.replace(
      '"schemaVersion":1}',
      '"schemaVersion":1,"schemaVersion":1}',
    );

    expect(decodeRecoveryRecordV1(new TextEncoder().encode(duplicate))).toEqual(
      { ok: false, code: "invalid-command" },
    );
  });

  it.each([
    [62, "invalid-command"],
    [63, "invalid-command"],
    [64, "recovery-limit"],
  ] as const)(
    "applies the bounded nesting limit at depth %s",
    (arrayDepth, code) => {
      const nested = `${"[".repeat(arrayDepth)}null${"]".repeat(arrayDepth)}`;
      const text = `{"record":${nested},"recordType":"attempt","schemaVersion":1}`;
      expect(decodeRecoveryRecordV1(new TextEncoder().encode(text))).toEqual({
        ok: false,
        code,
      });
    },
  );

  it("rejects malformed UTF-8 and over-limit records without throwing", () => {
    expect(decodeRecoveryRecordV1(Uint8Array.of(0xff))).toEqual({
      ok: false,
      code: "invalid-command",
    });
    const oversized = new Uint8Array(8 * 1024 * 1024 + 1);
    expect(decodeRecoveryRecordV1(oversized)).toEqual({
      ok: false,
      code: "recovery-limit",
    });
  });
});

describe("recovery forward/inverse semantic validation", () => {
  it.each(forwardAttempts())(
    "rejects a validly shaped but incorrect inverse while encoding",
    (record) => {
      expect(encodeRecoveryRecordV1({ ...record, inverse: FORWARD })).toEqual({
        ok: false,
        code: "invalid-command",
      });
    },
  );

  it("rejects a canonical decoded forward attempt with an incorrect inverse", () => {
    const record = forwardAttempts()[1];
    const encoded = encodeRecoveryRecordV1(record);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const envelope = JSON.parse(new TextDecoder().decode(encoded.value)) as {
      record: Record<string, unknown>;
      recordType: string;
      schemaVersion: number;
    };
    envelope.record.inverse = FORWARD;

    expect(decodeRecoveryRecordV1(encodeCanonicalJson(envelope))).toEqual({
      ok: false,
      code: "invalid-command",
    });
  });

  it("rejects an inverse accessor without executing it", () => {
    let getterCalls = 0;
    const record = {
      ...forwardAttempts()[0],
      get inverse(): AnnotationPatchV1 {
        getterCalls += 1;
        return INVERSE;
      },
    };

    expect(encodeRecoveryRecordV1(record)).toEqual({
      ok: false,
      code: "invalid-command",
    });
    expect(getterCalls).toBe(0);
  });
});
