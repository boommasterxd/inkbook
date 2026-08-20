import { expect, it } from "vitest";

import {
  parseHistoryEntryId,
  parseOperationId,
} from "../../../src/domain/operations";
import {
  createSaveGeneration,
  createSettingsRevision,
  createSidecarRevision,
  createSourceGeneration,
  parseRecoveryAttemptId,
  parseRelocationId,
  parseSha256Digest,
  type NoteSessionSnapshotV1,
} from "../../../src/application/note-session";
import {
  tryProjectNoteSessionStatus,
  tryProjectRuntimePersistenceStatus,
  type PersistenceStatusV1,
  type RecoveryStatusV1,
} from "../../../src/ui/status";
import { sessionSnapshot } from "../../application/note-session/session-support";

type SessionPersistenceV1 = NoteSessionSnapshotV1["persistence"];

const IDENTIFIER_PAYLOAD = "11111111111111111111111111";
const DIGEST_HEX_LENGTH = 64;
const TEST_SETTINGS_REVISION = 2;
const TEST_SOURCE_GENERATION = 3;
const TEST_SIDECAR_REVISION = 4;
const TEST_DIRTY_GENERATION = 5;
const TEST_SAVING_GENERATION = 6;
const SOURCE_DIGEST = parseSha256Digest("f".repeat(DIGEST_HEX_LENGTH));

const PERSISTENCE_CASES: readonly {
  readonly expected: PersistenceStatusV1;
  readonly state: SessionPersistenceV1;
}[] = [
  {
    expected: { kind: "unannotated" },
    state: { kind: "unannotated" },
  },
  {
    expected: { kind: "first-sidecar-pending" },
    state: {
      kind: "first-sidecar-pending",
      pending: {
        expectedSettingsRevision: createSettingsRevision(
          TEST_SETTINGS_REVISION,
        ),
        expectedSourceDigest: SOURCE_DIGEST,
        expectedSourceGeneration: createSourceGeneration(
          TEST_SOURCE_GENERATION,
        ),
        expectedVaultRelativePath: "notes/private.inkbook.json",
        historyEntryId: parseHistoryEntryId(`he_${IDENTIFIER_PAYLOAD}`),
        noteIdentity: {
          vaultIdHint: "private-vault",
          vaultRelativeMarkdownPath: "notes/private.md",
        },
        operationId: parseOperationId(`op_${IDENTIFIER_PAYLOAD}`),
        recoveryAttemptId: parseRecoveryAttemptId(`ra_${IDENTIFIER_PAYLOAD}`),
      },
    },
  },
  {
    expected: { kind: "clean", sidecarRevision: TEST_SIDECAR_REVISION },
    state: {
      kind: "clean",
      sidecarRevision: createSidecarRevision(TEST_SIDECAR_REVISION),
    },
  },
  {
    expected: { generation: TEST_DIRTY_GENERATION, kind: "dirty" },
    state: {
      generation: createSaveGeneration(TEST_DIRTY_GENERATION),
      kind: "dirty",
    },
  },
  {
    expected: { generation: TEST_SAVING_GENERATION, kind: "saving" },
    state: {
      generation: createSaveGeneration(TEST_SAVING_GENERATION),
      kind: "saving",
    },
  },
  {
    expected: { kind: "conflict" },
    state: { kind: "conflict" },
  },
  {
    expected: { kind: "drift" },
    state: { kind: "drift" },
  },
  {
    expected: { kind: "relocating" },
    state: {
      kind: "relocating",
      relocationId: parseRelocationId(`rel_${IDENTIFIER_PAYLOAD}`),
    },
  },
  {
    expected: { kind: "newer-version" },
    state: { kind: "newer-version" },
  },
];

const RECOVERY_CASES: readonly RecoveryStatusV1[] = [
  { kind: "none" },
  { bytesUsed: 0, kind: "available", recordCount: 0 },
  { bytesUsed: 128, kind: "pending", recordCount: 2 },
  { kind: "unavailable", reason: "backend" },
  { kind: "unavailable", reason: "quota" },
  { kind: "unavailable", reason: "corrupt" },
  { kind: "unavailable", reason: "disposed" },
  { kind: "limited", limit: "bytes" },
  { kind: "limited", limit: "records" },
  { kind: "limited", limit: "successors" },
  { kind: "conflict" },
  { kind: "reattachment-required" },
];

it.each(PERSISTENCE_CASES)(
  "projects the persistence state %#",
  ({ expected, state }) => {
    const result = tryProjectNoteSessionStatus(
      { ...sessionSnapshot(), persistence: state },
      { kind: "none" },
    );

    expect(result).toEqual({
      ok: true,
      value: { persistence: expected, recovery: { kind: "none" } },
    });
  },
);

it.each(RECOVERY_CASES)("projects the recovery state %#", (recovery) => {
  const result = tryProjectNoteSessionStatus(sessionSnapshot(), recovery);

  expect(result).toEqual({
    ok: true,
    value: {
      persistence: { kind: "clean", sidecarRevision: 1 },
      recovery,
    },
  });
});

it("returns a deeply immutable projection detached from its input", () => {
  const recovery = { bytesUsed: 16, kind: "available", recordCount: 1 };
  const result = tryProjectNoteSessionStatus(sessionSnapshot(), recovery);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.value)).toBe(true);
  expect(Object.isFrozen(result.value.persistence)).toBe(true);
  expect(Object.isFrozen(result.value.recovery)).toBe(true);

  recovery.bytesUsed = 32;
  expect(result.value.recovery).toEqual({
    bytesUsed: 16,
    kind: "available",
    recordCount: 1,
  });
});

it("redacts every sensitive session field from persistence status", () => {
  const sensitiveValues = [
    "/home/user/private-vault/notes/secret.md",
    "private-vault",
    `op_${IDENTIFIER_PAYLOAD}`,
    `he_${IDENTIFIER_PAYLOAD}`,
    `ra_${IDENTIFIER_PAYLOAD}`,
    SOURCE_DIGEST,
    "private markdown content",
    "private-yaml-value",
    "private anchor context",
    "private geometry",
    "private file contents",
    "private stack trace",
    "private secret",
  ] as const;
  const pending = {
    anchorContext: sensitiveValues[8],
    expectedSettingsRevision: createSettingsRevision(TEST_SETTINGS_REVISION),
    expectedSourceDigest: SOURCE_DIGEST,
    expectedSourceGeneration: createSourceGeneration(TEST_SOURCE_GENERATION),
    expectedVaultRelativePath: sensitiveValues[0],
    fileContents: sensitiveValues[10],
    geometry: sensitiveValues[9],
    historyEntryId: parseHistoryEntryId(`he_${IDENTIFIER_PAYLOAD}`),
    markdown: sensitiveValues[6],
    noteIdentity: {
      vaultIdHint: sensitiveValues[1],
      vaultRelativeMarkdownPath: sensitiveValues[0],
    },
    operationId: parseOperationId(`op_${IDENTIFIER_PAYLOAD}`),
    recoveryAttemptId: parseRecoveryAttemptId(`ra_${IDENTIFIER_PAYLOAD}`),
    secret: sensitiveValues[12],
    stack: sensitiveValues[11],
    yamlValue: sensitiveValues[7],
  };
  const snapshot = {
    ...sessionSnapshot(),
    persistence: { kind: "first-sidecar-pending", pending },
  } as NoteSessionSnapshotV1;

  const result = tryProjectNoteSessionStatus(snapshot, { kind: "none" });
  expect(result).toEqual({
    ok: true,
    value: {
      persistence: { kind: "first-sidecar-pending" },
      recovery: { kind: "none" },
    },
  });
  const serialized = JSON.stringify(result);
  for (const sensitiveValue of sensitiveValues) {
    expect(serialized).not.toContain(sensitiveValue);
  }
});

it("does not read sensitive pending or relocation identifiers", () => {
  let sensitiveReads = 0;
  const pending = Object.defineProperty(
    { kind: "first-sidecar-pending" },
    "pending",
    {
      enumerable: true,
      get: (): never => {
        sensitiveReads += 1;
        throw new Error("Sensitive pending details must not be read.");
      },
    },
  ) as SessionPersistenceV1;
  const relocation = Object.defineProperty(
    { kind: "relocating" },
    "relocationId",
    {
      enumerable: true,
      get: (): never => {
        sensitiveReads += 1;
        throw new Error("Sensitive relocation ID must not be read.");
      },
    },
  ) as SessionPersistenceV1;

  expect(
    tryProjectNoteSessionStatus(
      { ...sessionSnapshot(), persistence: pending },
      { kind: "none" },
    ),
  ).toMatchObject({ ok: true });
  expect(
    tryProjectNoteSessionStatus(
      { ...sessionSnapshot(), persistence: relocation },
      { kind: "none" },
    ),
  ).toMatchObject({ ok: true });
  expect(sensitiveReads).toBe(0);
});

it("fails closed without exposing invalid recovery or snapshot details", () => {
  const invalidRecovery = {
    internalError: "private stack and absolute /home/user/vault path",
    kind: "unavailable",
    reason: "backend",
  };
  const invalidRecoveryResult = tryProjectNoteSessionStatus(
    sessionSnapshot(),
    invalidRecovery,
  );
  expect(invalidRecoveryResult).toEqual({
    code: "invalid-status",
    ok: false,
  });
  expect(JSON.stringify(invalidRecoveryResult)).not.toContain("private");

  const hostileSnapshot = new Proxy(sessionSnapshot(), {
    get: (target, property, receiver): unknown => {
      if (property === "persistence") {
        throw new Error("private internal snapshot failure");
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const invalidSnapshotResult = tryProjectNoteSessionStatus(hostileSnapshot, {
    kind: "none",
  });
  expect(invalidSnapshotResult).toEqual({
    code: "invalid-status",
    ok: false,
  });
  expect(JSON.stringify(invalidSnapshotResult)).not.toContain("private");
});

it("projects sanitized runtime conflict, drift, and retry causes", () => {
  const result = tryProjectRuntimePersistenceStatus(
    { ...sessionSnapshot(), persistence: { kind: "drift" } },
    { kind: "none" },
    {
      conflict: { kind: "none" },
      drift: { kind: "marker-invalid" },
      retry: { action: "marker", attemptCount: 2, kind: "available" },
    },
  );

  expect(result).toEqual({
    ok: true,
    value: {
      conflict: { kind: "none" },
      drift: { kind: "marker-invalid" },
      persistence: { kind: "drift" },
      recovery: { kind: "none" },
      retry: { action: "marker", attemptCount: 2, kind: "available" },
    },
  });
});

it("fails closed for hostile runtime issue details", () => {
  const issue = new Proxy(
    {
      conflict: { kind: "none" },
      drift: { kind: "none" },
      retry: { kind: "not-required" },
    },
    {
      get: (): never => {
        throw new Error("private path /home/user/vault/note.md");
      },
    },
  );

  expect(
    tryProjectRuntimePersistenceStatus(
      sessionSnapshot(),
      { kind: "none" },
      issue,
    ),
  ).toEqual({ code: "invalid-status", ok: false });
});
