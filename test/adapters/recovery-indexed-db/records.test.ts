/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact recovery revisions and ordering boundaries are under test. */
import { describe, expect, it } from "vitest";

import {
  createSidecarRevision,
  createSourceGeneration,
  parseRecoveryAttemptId,
  parseSourceCheckpointId,
} from "../../../src/application/note-session";
import { createSceneRevision } from "../../../src/domain/model";
import {
  BASE,
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
} from "./support";

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
    await expect(
      store.recordForward(prepared.attemptId, hostAcknowledgement()),
    ).resolves.toEqual({ ok: true, value: undefined });
    await store.appendDirection(directionAttempt(2, 2));
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
    await expect(
      store.recordForward(attempt.attemptId, acknowledged),
    ).resolves.toEqual({ ok: true, value: undefined });
    await expect(
      store.recordForward(attempt.attemptId, acknowledged),
    ).resolves.toEqual({ ok: true, value: undefined });
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
        sourceDigest: DIGEST_B,
        sourceGeneration: createSourceGeneration(2),
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
