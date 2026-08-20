import { describe, expect, it } from "vitest";

import { createSceneRevision } from "../../../src/domain/model";
import {
  parseHistoryEntryId,
  parseOperationId,
  type ReplaceNoteAppearancePatchV1,
} from "../../../src/domain/operations";
import {
  createHistoryEpoch,
  createHostTransactionSequence,
  createSessionOrder,
  createSettingsRevision,
  createSidecarRevision,
  createSourceGeneration,
  parseHostEffectId,
  parseRecoveryAttemptId,
  parseSha256Digest,
  parseSourceCheckpointId,
  parseViewId,
} from "../../../src/application/note-session";
import {
  validateFirstSidecarRecovery,
  validateSidecarAcknowledgement,
  type FirstSidecarRecoveryContextV1,
  type HostRecordedForwardAttemptV1,
  type SidecarRecoveryAcknowledgementV1,
} from "../../../src/application/recovery";

/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact revisions identify first and successor sidecars. */

const PAYLOAD = "00000000000000000000000000";
const DIGEST_LENGTH = 64;
const DIGEST_A = parseSha256Digest("a".repeat(DIGEST_LENGTH));
const DIGEST_B = parseSha256Digest("b".repeat(DIGEST_LENGTH));
const NOTE = {
  vaultIdHint: "vault",
  vaultRelativeMarkdownPath: "notes/source.md",
};
const PATCH: ReplaceNoteAppearancePatchV1 = {
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
};

function firstSidecarFixture(): {
  readonly pending: Parameters<typeof validateFirstSidecarRecovery>[0];
  readonly attempt: HostRecordedForwardAttemptV1;
  readonly context: FirstSidecarRecoveryContextV1;
} {
  const operationId = parseOperationId(`op_${PAYLOAD}`);
  const historyEntryId = parseHistoryEntryId(`he_${PAYLOAD}`);
  const attemptId = parseRecoveryAttemptId(`ra_${PAYLOAD}`);
  const settingsRevision = createSettingsRevision(1);
  const expectedVaultRelativePath = "notes/source.inkbook.json";
  const context = {
    expectedSceneRevision: createSceneRevision(0),
    expectedSettingsRevision: settingsRevision,
    expectedSourceDigest: DIGEST_A,
    expectedSourceGeneration: createSourceGeneration(1),
    expectedVaultRelativePath,
    historyEntryId,
    noteIdentity: NOTE,
    operationId,
  };
  return {
    attempt: {
      acknowledgement: {
        direction: "forward",
        editorViewId: parseViewId("view-a"),
        effectId: parseHostEffectId(`eff_${PAYLOAD}`),
        transactionSequence: createHostTransactionSequence(1),
      },
      attemptId,
      base: {
        markdownPath: NOTE.vaultRelativeMarkdownPath,
        rawTextSha256: null,
        revision: null,
        vaultRelativePath: expectedVaultRelativePath,
      },
      expectedSceneRevision: createSceneRevision(0),
      expectedSourceDigest: DIGEST_A,
      expectedSourceGeneration: createSourceGeneration(1),
      forward: PATCH,
      historyEntryId,
      historyEpoch: createHistoryEpoch(1),
      inverse: { ...PATCH, prior: PATCH.replacement, replacement: PATCH.prior },
      kind: "host-recorded-forward",
      operationId,
      sessionOrder: createSessionOrder(1),
    },
    context,
    pending: {
      expectedSettingsRevision: settingsRevision,
      expectedSourceDigest: DIGEST_A,
      expectedSourceGeneration: createSourceGeneration(1),
      expectedVaultRelativePath,
      historyEntryId,
      noteIdentity: NOTE,
      operationId,
      recoveryAttemptId: attemptId,
    },
  };
}

describe("first sidecar recovery validation", () => {
  it("accepts only the exact pending host-recorded Forward", () => {
    const fixture = firstSidecarFixture();
    expect(
      validateFirstSidecarRecovery(
        fixture.pending,
        fixture.attempt,
        fixture.context,
      ),
    ).toEqual({ ok: true, value: undefined });
    expect(
      validateFirstSidecarRecovery(
        fixture.pending,
        {
          ...fixture.attempt,
          expectedSourceDigest: DIGEST_B,
        },
        fixture.context,
      ),
    ).toEqual({ ok: false, code: "invalid-command" });
  });
});

describe("sidecar acknowledgement validation", () => {
  function acknowledgement(): SidecarRecoveryAcknowledgementV1 {
    return {
      acknowledgedReplacementBase: {
        markdownPath: NOTE.vaultRelativeMarkdownPath,
        rawTextSha256: DIGEST_B,
        revision: createSidecarRevision(2),
        vaultRelativePath: "notes/source.inkbook.json",
      },
      coveredAttemptIds: [parseRecoveryAttemptId(`ra_${PAYLOAD}`)],
      coveredCheckpointIds: [parseSourceCheckpointId(`scp_${PAYLOAD}`)],
      expectedPriorBase: {
        markdownPath: NOTE.vaultRelativeMarkdownPath,
        rawTextSha256: DIGEST_A,
        revision: createSidecarRevision(1),
        vaultRelativePath: "notes/source.inkbook.json",
      },
      noteIdentity: NOTE,
      sceneRevision: createSceneRevision(2),
      sidecarRevision: createSidecarRevision(2),
      sourceDigest: DIGEST_B,
      sourceGeneration: createSourceGeneration(2),
    };
  }

  it("accepts one exact successor acknowledgement", () => {
    expect(validateSidecarAcknowledgement(acknowledgement())).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("rejects revision skips, duplicate coverage, and partial bases", () => {
    const valid = acknowledgement();
    expect(
      validateSidecarAcknowledgement({
        ...valid,
        acknowledgedReplacementBase: {
          ...valid.acknowledgedReplacementBase,
          revision: createSidecarRevision(3),
        },
        sidecarRevision: createSidecarRevision(3),
      }).ok,
    ).toBe(false);
    expect(
      validateSidecarAcknowledgement({
        ...valid,
        coveredAttemptIds: [
          valid.coveredAttemptIds[0] as never,
          valid.coveredAttemptIds[0] as never,
        ],
      }).ok,
    ).toBe(false);
    expect(
      validateSidecarAcknowledgement({
        ...valid,
        expectedPriorBase: { ...valid.expectedPriorBase, rawTextSha256: null },
      }).ok,
    ).toBe(false);
  });
});
