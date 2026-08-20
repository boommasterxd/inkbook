/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact recovery revisions and ordering boundaries are under test. */
import { describe, expect, it } from "vitest";

import { encodeRecoveryRecordV1 } from "../../../src/application/recovery";
import {
  createSidecarRevision,
  createSourceGeneration,
  parseRecoveryAttemptId,
  parseSha256Digest,
  parseSourceCheckpointId,
} from "../../../src/application/note-session";
import { createSceneRevision } from "../../../src/domain/model";
import {
  BASE,
  DIGEST_A,
  DIGEST_B,
  NEXT_BASE,
  NOTE,
  checkpoint,
  corruptStoredRecord,
  directionAttempt,
  existingLoad,
  hostAcknowledgement,
  idPayload,
  openStore,
  preparedAttempt,
  replaceStoredEncoded,
} from "./support";

const DIGEST_C = parseSha256Digest("c".repeat(64));

// eslint-disable-next-line max-lines-per-function -- The record lifecycle scenarios form one cohesive adapter contract suite.
describe("IndexedDB recovery records", () => {
  it("persists every attempt transition across restart and preserves idempotency", async () => {
    const { store, factory } = await openStore("attempt-restart");
    const prepared = preparedAttempt();
    await expect(store.prepareForward(prepared)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(store.prepareForward(prepared)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    const recorded = await store.recordForward(
      prepared.attemptId,
      hostAcknowledgement(),
    );
    expect(recorded).toMatchObject({
      ok: true,
      value: {
        attemptId: prepared.attemptId,
        kind: "host-recorded-forward",
      },
    });
    if (!recorded.ok) throw new Error("Expected a durable forward attempt.");
    expect(Object.isFrozen(recorded.value)).toBe(true);
    expect(Object.isFrozen(recorded.value.acknowledgement)).toBe(true);
    expect(Object.isFrozen(recorded.value.base)).toBe(true);
    expect(Object.isFrozen(recorded.value.forward)).toBe(true);
    const direction = directionAttempt(2, 2);
    const appended = await store.appendDirection(direction);
    expect(appended).toEqual({ ok: true, value: direction });
    if (!appended.ok) throw new Error("Expected a durable direction attempt.");
    expect(Object.isFrozen(appended.value)).toBe(true);
    expect(Object.isFrozen(appended.value.acknowledgement)).toBe(true);
    await store.dispose();

    const reopened = await openStore("attempt-restart", {}, factory);
    await expect(
      reopened.store.loadNote(existingLoad()),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        attempts: [
          { kind: "host-recorded-forward" },
          { kind: "host-recorded-undo" },
        ],
      },
    });
    await reopened.store.dispose();
  });

  it("uses compare-and-swap for competing prepared bytes and host acknowledgements", async () => {
    const { store: first, factory } = await openStore("attempt-race");
    const { store: second } = await openStore("attempt-race", {}, factory);
    const attempt = preparedAttempt();
    const conflicting = {
      ...attempt,
      expectedSceneRevision: createSceneRevision(2),
    };
    const prepares = await Promise.all([
      first.prepareForward(attempt),
      second.prepareForward(conflicting),
    ]);
    expect(prepares.filter((result) => result.ok)).toHaveLength(1);
    expect(prepares.filter((result) => !result.ok)).toEqual([
      { ok: false, code: "sidecar-conflict" },
    ]);

    const acknowledgements = await Promise.all([
      first.recordForward(attempt.attemptId, hostAcknowledgement(1)),
      second.recordForward(attempt.attemptId, hostAcknowledgement(2)),
    ]);
    expect(acknowledgements.filter((result) => result.ok)).toHaveLength(1);
    expect(acknowledgements.filter((result) => !result.ok)).toEqual([
      { ok: false, code: "sidecar-conflict" },
    ]);
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it("never overwrites one durable host acknowledgement on a later retry", async () => {
    const { store } = await openStore("durable-host-acknowledgement");
    const attempt = preparedAttempt();
    const acknowledged = hostAcknowledgement(1);
    await store.prepareForward(attempt);
    const first = await store.recordForward(attempt.attemptId, acknowledged);
    const retry = await store.recordForward(attempt.attemptId, acknowledged);
    expect(first.ok).toBe(true);
    expect(retry).toEqual(first);
    await expect(
      store.recordForward(attempt.attemptId, hostAcknowledgement(2)),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await expect(store.loadNote(existingLoad())).resolves.toMatchObject({
      ok: true,
      value: { attempts: [{ acknowledgement: acknowledged }] },
    });
    await store.dispose();
  });

  it("preserves the session-order high-water after complete cleanup", async () => {
    const { store } = await openStore("session-order-after-cleanup");
    const covered = preparedAttempt(1, 1);
    await store.prepareForward(covered);
    await expect(
      store.acknowledgeSidecar({
        acknowledgedReplacementBase: NEXT_BASE,
        coveredAttemptIds: [covered.attemptId],
        coveredCheckpointIds: [],
        expectedPriorBase: BASE,
        noteIdentity: NOTE,
        sceneRevision: createSceneRevision(2),
        sidecarRevision: createSidecarRevision(2),
        sourceDigest: DIGEST_A,
        sourceGeneration: createSourceGeneration(1),
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    await expect(
      store.prepareForward(preparedAttempt(2, 1, NEXT_BASE, 2)),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await expect(
      store.prepareForward(preparedAttempt(2, 2, NEXT_BASE, 2)),
    ).resolves.toEqual({ ok: true, value: undefined });
    await store.dispose();
  });

  it("rejects invalid acknowledgement metadata and rebases a later checkpoint", async () => {
    const { store } = await openStore("sidecar-acknowledgement-validation");
    const covered = preparedAttempt(1, 1);
    const retainedCheckpoint = checkpoint(1, 2);
    await store.prepareForward(covered);
    await store.appendSourceCheckpoint(retainedCheckpoint);
    const request = {
      acknowledgedReplacementBase: NEXT_BASE,
      coveredAttemptIds: [covered.attemptId],
      coveredCheckpointIds: [] as const,
      expectedPriorBase: BASE,
      noteIdentity: NOTE,
      sceneRevision: createSceneRevision(2),
      sidecarRevision: createSidecarRevision(2),
      sourceDigest: DIGEST_A,
      sourceGeneration: createSourceGeneration(1),
    };
    await expect(
      store.acknowledgeSidecar({
        ...request,
        sceneRevision: -1 as typeof request.sceneRevision,
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await expect(store.acknowledgeSidecar(request)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    const finalBase = {
      ...NEXT_BASE,
      rawTextSha256: DIGEST_A,
      revision: createSidecarRevision(3),
    };
    await expect(
      store.acknowledgeSidecar({
        acknowledgedReplacementBase: finalBase,
        coveredAttemptIds: [],
        coveredCheckpointIds: [retainedCheckpoint.checkpointId],
        expectedPriorBase: NEXT_BASE,
        noteIdentity: NOTE,
        sceneRevision: createSceneRevision(2),
        sidecarRevision: createSidecarRevision(3),
        sourceDigest: DIGEST_B,
        sourceGeneration: createSourceGeneration(2),
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    await expect(
      store.loadNote(existingLoad(finalBase, DIGEST_B, 5)),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        attempts: [],
        checkpoints: [],
      },
    });
    await store.dispose();
  });

  it("atomically deletes covered records and rebases only retained direct successors", async () => {
    const { store } = await openStore("sidecar-acknowledgement");
    const covered = preparedAttempt(1, 1, BASE, 1);
    const retained = {
      ...preparedAttempt(2, 3, BASE, 2),
      expectedSourceDigest: DIGEST_B,
      expectedSourceGeneration: createSourceGeneration(2),
    };
    const sourceCheckpoint = checkpoint(1, 2);
    await store.prepareForward(covered);
    await store.appendSourceCheckpoint(sourceCheckpoint);
    await store.prepareForward(retained);

    await expect(
      store.acknowledgeSidecar({
        acknowledgedReplacementBase: NEXT_BASE,
        coveredAttemptIds: [covered.attemptId],
        coveredCheckpointIds: [sourceCheckpoint.checkpointId],
        expectedPriorBase: BASE,
        noteIdentity: NOTE,
        sceneRevision: createSceneRevision(2),
        sidecarRevision: createSidecarRevision(2),
        sourceDigest: DIGEST_B,
        sourceGeneration: createSourceGeneration(2),
      }),
    ).resolves.toEqual({ ok: true, value: undefined });

    await expect(
      store.loadNote(existingLoad(NEXT_BASE, DIGEST_B, 5)),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        attempts: [{ attemptId: retained.attemptId, base: NEXT_BASE }],
        checkpoints: [],
      },
    });
    await store.dispose();
  });

  it("rejects checkpoint cleanup when the acknowledged source evidence does not match", async () => {
    const { store } = await openStore("sidecar-source-evidence-conflict");
    const covered = preparedAttempt(1, 1, BASE, 1);
    const sourceCheckpoint = checkpoint(1, 2);
    await store.prepareForward(covered);
    await store.appendSourceCheckpoint(sourceCheckpoint);

    await expect(
      store.acknowledgeSidecar({
        acknowledgedReplacementBase: NEXT_BASE,
        coveredAttemptIds: [covered.attemptId],
        coveredCheckpointIds: [sourceCheckpoint.checkpointId],
        expectedPriorBase: BASE,
        noteIdentity: NOTE,
        sceneRevision: createSceneRevision(2),
        sidecarRevision: createSidecarRevision(2),
        sourceDigest: DIGEST_A,
        sourceGeneration: createSourceGeneration(2),
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await expect(
      store.acknowledgeSidecar({
        acknowledgedReplacementBase: NEXT_BASE,
        coveredAttemptIds: [covered.attemptId],
        coveredCheckpointIds: [sourceCheckpoint.checkpointId],
        expectedPriorBase: BASE,
        noteIdentity: NOTE,
        sceneRevision: createSceneRevision(2),
        sidecarRevision: createSidecarRevision(2),
        sourceDigest: DIGEST_B,
        sourceGeneration: createSourceGeneration(2),
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    await store.dispose();
  });

  it("accepts an empty recovery acknowledgement as an idempotent no-op", async () => {
    const { store } = await openStore("sidecar-empty-acknowledgement");
    const request = {
      acknowledgedReplacementBase: NEXT_BASE,
      coveredAttemptIds: [] as const,
      coveredCheckpointIds: [] as const,
      expectedPriorBase: BASE,
      noteIdentity: NOTE,
      sceneRevision: createSceneRevision(2),
      sidecarRevision: createSidecarRevision(2),
      sourceDigest: DIGEST_A,
      sourceGeneration: createSourceGeneration(1),
    };
    await expect(store.acknowledgeSidecar(request)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(store.acknowledgeSidecar(request)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(store.loadNote(existingLoad())).resolves.toMatchObject({
      ok: true,
      value: { attempts: [], checkpoints: [] },
    });
    await store.dispose();
  });

  it("fails acknowledgement closed after a database version change", async () => {
    const name = "sidecar-acknowledgement-version-change";
    const { store, factory } = await openStore(name);
    await new Promise<void>((resolve, reject) => {
      const deletion = factory.deleteDatabase(name);
      deletion.onerror = (): void =>
        reject(deletion.error ?? new Error("Expected database deletion."));
      deletion.onsuccess = (): void => resolve();
    });
    await expect(
      store.acknowledgeSidecar({
        acknowledgedReplacementBase: NEXT_BASE,
        coveredAttemptIds: [],
        coveredCheckpointIds: [],
        expectedPriorBase: BASE,
        noteIdentity: NOTE,
        sceneRevision: createSceneRevision(2),
        sidecarRevision: createSidecarRevision(2),
        sourceDigest: DIGEST_A,
        sourceGeneration: createSourceGeneration(1),
      }),
    ).resolves.toEqual({ ok: false, code: "recovery-unavailable" });
    await store.dispose();
  });

  it("requires a contiguous multi-checkpoint generation, digest, and length chain", async () => {
    const gaps = [
      {
        priorGeneration: createSourceGeneration(3),
        replacementGeneration: createSourceGeneration(4),
      },
      { priorDigest: DIGEST_A },
      { priorUtf16Length: 4, replacementUtf16Length: 5 },
    ] as const;
    for (const [index, overrides] of gaps.entries()) {
      const name = `sidecar-checkpoint-gap-${String(index)}`;
      const { store, factory } = await openStore(name);
      const attempt = preparedAttempt(1, 1);
      const first = checkpoint(1, 2);
      const second = successorCheckpoint();
      await store.prepareForward(attempt);
      await store.appendSourceCheckpoint(first);
      await store.appendSourceCheckpoint(second);
      await store.dispose();
      const corrupted = encodeRecoveryRecordV1(successorCheckpoint(overrides));
      if (!corrupted.ok) throw new Error("Expected valid corrupted fixture.");
      await replaceStoredEncoded(
        factory,
        name,
        `checkpoint:${second.checkpointId}`,
        corrupted.value,
      );
      const reopened = await openStore(name, {}, factory);
      await expect(
        reopened.store.acknowledgeSidecar(
          chainAcknowledgement(attempt, first, second),
        ),
      ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
      await reopened.store.dispose();
    }

    const { store } = await openStore("sidecar-checkpoint-contiguous");
    const attempt = preparedAttempt(1, 1);
    const first = checkpoint(1, 2);
    const second = successorCheckpoint();
    await store.prepareForward(attempt);
    await store.appendSourceCheckpoint(first);
    await store.appendSourceCheckpoint(second);
    await expect(
      store.acknowledgeSidecar(chainAcknowledgement(attempt, first, second)),
    ).resolves.toEqual({ ok: true, value: undefined });
    await store.dispose();
  });

  it("aborts stale, missing, forked, and evidence-mismatched acknowledgements", async () => {
    const { store } = await openStore("sidecar-conflicts");
    const attempt = preparedAttempt();
    await store.prepareForward(attempt);
    const common = {
      acknowledgedReplacementBase: NEXT_BASE,
      coveredAttemptIds: [parseRecoveryAttemptId(`ra_${idPayload(99)}`)],
      coveredCheckpointIds: [] as const,
      expectedPriorBase: BASE,
      noteIdentity: NOTE,
      sceneRevision: createSceneRevision(2),
      sidecarRevision: createSidecarRevision(2),
      sourceDigest: DIGEST_B,
      sourceGeneration: createSourceGeneration(2),
    };
    await expect(store.acknowledgeSidecar(common)).resolves.toEqual({
      ok: false,
      code: "sidecar-conflict",
    });
    await expect(
      store.acknowledgeSidecar({
        ...common,
        coveredAttemptIds: [attempt.attemptId],
        coveredCheckpointIds: [parseSourceCheckpointId(`scp_${idPayload(99)}`)],
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await expect(store.loadNote(existingLoad())).resolves.toMatchObject({
      ok: true,
      value: { attempts: [{ attemptId: attempt.attemptId }] },
    });
    await store.dispose();
  });

  it("loads only the requested note through its exact note index", async () => {
    const name = "note-index-isolation";
    const { store, factory } = await openStore(name);
    const otherBase = {
      ...BASE,
      markdownPath: "notes/other.md",
      vaultRelativePath: "notes/other.inkbook.json",
    };
    await store.prepareForward(preparedAttempt(1, 1));
    const foreign = preparedAttempt(2, 1, otherBase);
    await store.prepareForward(foreign);
    await corruptStoredRecord(factory, name, `attempt:${foreign.attemptId}`);
    await expect(store.loadNote(existingLoad())).resolves.toMatchObject({
      ok: true,
      value: { attempts: [{ attemptId: preparedAttempt(1, 1).attemptId }] },
    });
    await store.dispose();
  });
});

function successorCheckpoint(
  overrides: Partial<ReturnType<typeof checkpoint>> = {},
): ReturnType<typeof checkpoint> {
  return {
    ...checkpoint(2, 3),
    checkpointId: parseSourceCheckpointId(`scp_${idPayload(2)}`),
    priorDigest: DIGEST_B,
    priorGeneration: createSourceGeneration(2),
    priorUtf16Length: 5,
    replacementDigest: DIGEST_C,
    replacementGeneration: createSourceGeneration(3),
    replacementUtf16Length: 6,
    ...overrides,
  };
}

function chainAcknowledgement(
  attempt: ReturnType<typeof preparedAttempt>,
  first: ReturnType<typeof checkpoint>,
  second: ReturnType<typeof checkpoint>,
): Parameters<
  Awaited<ReturnType<typeof openStore>>["store"]["acknowledgeSidecar"]
>[0] {
  return {
    acknowledgedReplacementBase: NEXT_BASE,
    coveredAttemptIds: [attempt.attemptId],
    coveredCheckpointIds: [first.checkpointId, second.checkpointId],
    expectedPriorBase: BASE,
    noteIdentity: NOTE,
    sceneRevision: createSceneRevision(2),
    sidecarRevision: createSidecarRevision(2),
    sourceDigest: DIGEST_C,
    sourceGeneration: createSourceGeneration(3),
  };
}
