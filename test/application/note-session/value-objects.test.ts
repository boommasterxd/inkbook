import { describe, expect, it } from "vitest";

import {
  createHistoryEpoch,
  createHostTransactionSequence,
  createLayoutRevision,
  createSaveGeneration,
  createSessionOrder,
  createSettingsRevision,
  createSidecarRevision,
  createSourceGeneration,
  freezeNoteIdentity,
  parseHostEffectId,
  parseRecoveryAttemptId,
  parseRelocationId,
  parseRemovalId,
  parseSha256Digest,
  parseSourceCheckpointId,
  parseViewId,
} from "../../../src/application/note-session";

const PAYLOAD = "00000000000000000000000000";
const DIGEST_LENGTH = 64;

describe("note-session value objects", () => {
  it("creates every closed application ID and positive counter", () => {
    expect(parseHostEffectId(`eff_${PAYLOAD}`)).toContain("eff_");
    expect(parseRecoveryAttemptId(`ra_${PAYLOAD}`)).toContain("ra_");
    expect(parseSourceCheckpointId(`scp_${PAYLOAD}`)).toContain("scp_");
    expect(parseRelocationId(`rel_${PAYLOAD}`)).toContain("rel_");
    expect(parseRemovalId(`rm_${PAYLOAD}`)).toContain("rm_");
    expect(parseSha256Digest("a".repeat(DIGEST_LENGTH))).toHaveLength(
      DIGEST_LENGTH,
    );
    expect([
      createHistoryEpoch(1),
      createHostTransactionSequence(1),
      createSessionOrder(1),
      createSidecarRevision(1),
      createSaveGeneration(1),
      createSourceGeneration(1),
      createSettingsRevision(1),
      createLayoutRevision(1),
    ]).toEqual(Array.from({ length: 8 }, () => 1));
  });

  it.each([
    (): unknown => parseHostEffectId("eff_invalid"),
    (): unknown => parseRecoveryAttemptId(`ra_8${PAYLOAD.slice(1)}`),
    (): unknown => parseSha256Digest("A".repeat(DIGEST_LENGTH)),
    (): unknown => parseViewId(""),
    (): unknown => parseViewId("a\0b"),
    (): unknown => createSessionOrder(0),
    (): unknown => createSourceGeneration(Number.NaN),
  ])("rejects invalid identity or counter %#", (operation) => {
    expect(operation).toThrow();
  });

  it("freezes validated identities and rejects unsafe values", () => {
    const identity = freezeNoteIdentity({
      vaultIdHint: "vault",
      vaultRelativeMarkdownPath: "notes/source.md",
    });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(() =>
      freezeNoteIdentity({
        vaultIdHint: "",
        vaultRelativeMarkdownPath: "notes/source.md",
      }),
    ).toThrow();
    expect(() =>
      freezeNoteIdentity({
        vaultIdHint: "vault",
        vaultRelativeMarkdownPath: "bad\0path",
      }),
    ).toThrow();
  });
});
