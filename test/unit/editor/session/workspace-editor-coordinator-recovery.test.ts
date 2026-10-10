import { describe, expect, it, vi } from "vitest";
import type { ExternalChangeResult } from "../../../../src/editor/session/session-port";

import {
  activate,
  createHarness,
  documentA,
  documentASecondView,
  documentB,
  enterHeadlessRecovery,
} from "./workspace-editor-coordinator-fixture";

async function prepareAttachedRecovery(harness: ReturnType<typeof createHarness>) {
  const session = await activate(harness, documentA);
  session.snapshot = { ...session.snapshot, dirty: true, revision: 2 };
  harness.coordinator.mountAttachment(documentB);
  const activation = harness.coordinator.requestActivation(documentB);
  session.completeSave("failed");
  await Promise.resolve();
  return { activation, session };
}

async function prepareExternalReplacement(changed: Partial<ExternalChangeResult> = {}) {
  const harness = createHarness();
  const session = await activate(harness, documentA);
  vi.spyOn(session, "notifyExternalChange").mockImplementation(async (operation) => {
    session.snapshot = { ...session.snapshot, workerEpoch: 2 };
    return { ...operation!, outcome: "reloaded", workerEpoch: 2, ...changed };
  });
  return { harness, session };
}

describe("WorkspaceEditorCoordinator recovery outcomes", () => {
  it("accepts an operation-bound external reload after its own executor replacement", async () => {
    const { harness, session } = await prepareExternalReplacement();
    expect(await harness.coordinator.notifyExternalChange(documentA.documentId)).toBe("reloaded");
    expect(harness.release).toHaveBeenCalledOnce();
    expect(harness.coordinator.getSnapshot().current?.phase).toBe("active");
    await harness.coordinator.requestActivation(documentA).outcome;
    expect(session.cancelled).toEqual([]);
  });

  it.each([
    { workerEpoch: 3 },
    { workerEpoch: 1 },
    { sessionId: "foreign" },
    { documentId: "foreign.svg" },
    { operationId: 99 },
    { workspaceToken: 99 },
    { expectedSourceIdentity: { outputHash: "foreign", revision: 99 } },
  ])("rejects an unrelated or stale external replacement proof: %j", async (changed) => {
    const { harness, session } = await prepareExternalReplacement(changed);
    expect(await harness.coordinator.notifyExternalChange(documentA.documentId)).toBe("ignored");
    expect(harness.release).not.toHaveBeenCalled();
    expect(harness.attachedRecoveryRequired).not.toHaveBeenCalled();
    await harness.coordinator.requestActivation(documentA).outcome;
    expect(session.cancelled).toEqual([]);
  });

  it("rejects an unproved string outcome after an executor epoch changes", async () => {
    const harness = createHarness();
    const session = await activate(harness, documentA);
    vi.spyOn(session, "notifyExternalChange").mockImplementation(async () => {
      session.snapshot = { ...session.snapshot, workerEpoch: 2 };
      return "reloaded";
    });
    expect(await harness.coordinator.notifyExternalChange(documentA.documentId)).toBe("ignored");
    expect(harness.release).not.toHaveBeenCalled();
  });

  it("rejects a replacement proof after the presentation attachment changes", async () => {
    const harness = createHarness();
    const session = await activate(harness, documentA);
    let complete!: () => void;
    vi.spyOn(session, "notifyExternalChange").mockImplementation(
      (operation) =>
        new Promise((resolve) => {
          complete = () => resolve({ ...operation!, outcome: "reloaded", workerEpoch: 2 });
        }),
    );
    const reloading = harness.coordinator.notifyExternalChange(documentA.documentId);
    session.snapshot = { ...session.snapshot, workerEpoch: 2 };
    harness.coordinator.mountAttachment(documentASecondView);
    await harness.coordinator.requestActivation(documentASecondView).outcome;
    expect(session.cancelled).toEqual([
      expect.objectContaining({
        attachment: {
          attachmentId: documentA.attachmentId,
          attachmentGeneration: documentA.attachmentGeneration,
        },
      }),
    ]);
    const releaseCount = harness.release.mock.calls.length;
    complete();
    expect(await reloading).toBe("ignored");
    expect(harness.release).toHaveBeenCalledTimes(releaseCount);
  });
});

describe("WorkspaceEditorCoordinator external reload ownership", () => {
  it("does not let an older result clear or adopt a newer reload", async () => {
    const harness = createHarness();
    const session = await activate(harness, documentA);
    const completions: (() => void)[] = [];
    vi.spyOn(session, "notifyExternalChange").mockImplementation(
      () =>
        new Promise((resolve) => {
          completions.push(() => resolve("reloaded"));
        }),
    );
    const older = harness.coordinator.notifyExternalChange(documentA.documentId);
    const newer = harness.coordinator.notifyExternalChange(documentA.documentId);
    expect(session.cancelled).toHaveLength(1);
    completions[0]!();
    expect(await older).toBe("ignored");
    expect(harness.release).not.toHaveBeenCalled();
    completions[1]!();
    expect(await newer).toBe("reloaded");
    expect(harness.release).toHaveBeenCalledOnce();
    await harness.coordinator.requestActivation(documentA).outcome;
    expect(session.cancelled).toHaveLength(1);
  });
});

describe("WorkspaceEditorCoordinator unchanged recovery outcomes", () => {
  it("remounts a clean external reload and enters recovery for a dirty conflict", async () => {
    const cleanHarness = createHarness();
    const clean = await activate(cleanHarness, documentA);
    clean.externalChangeOutcome = "reloaded";

    await expect(cleanHarness.coordinator.notifyExternalChange(documentA.documentId)).resolves.toBe(
      "reloaded",
    );
    expect(cleanHarness.release).toHaveBeenCalledWith({
      attachmentGeneration: documentA.attachmentGeneration,
      attachmentId: documentA.attachmentId,
    });
    expect(cleanHarness.coordinator.getSnapshot().current?.phase).toBe("active");

    const dirtyHarness = createHarness();
    const dirty = await activate(dirtyHarness, documentA);
    dirty.snapshot = { ...dirty.snapshot, dirty: true, revision: 1 };
    dirty.externalChangeOutcome = "conflict";
    await expect(dirtyHarness.coordinator.notifyExternalChange(documentA.documentId)).resolves.toBe(
      "conflict",
    );
    expect(dirtyHarness.coordinator.getSnapshot().current?.phase).toBe("save-error");
    expect(dirtyHarness.attachedRecoveryRequired).toHaveBeenCalledOnce();
  });

  it("keeps the active presentation unchanged for a confirmed host write notification", async () => {
    const harness = createHarness();
    const session = await activate(harness, documentA);
    session.externalChangeOutcome = "unchanged";

    await expect(harness.coordinator.notifyExternalChange(documentA.documentId)).resolves.toBe(
      "unchanged",
    );

    expect(harness.coordinator.getSnapshot().current?.phase).toBe("active");
    expect(harness.release).not.toHaveBeenCalled();
    expect(harness.disableInput).not.toHaveBeenCalled();
    expect(harness.attachedRecoveryRequired).not.toHaveBeenCalled();
  });

  it("resolves headless recovery before activating the waiting document", async () => {
    const harness = createHarness();
    const session = await enterHeadlessRecovery(harness);
    harness.coordinator.mountAttachment(documentB);
    const waiting = harness.coordinator.requestActivation(documentB);

    const recovery = harness.coordinator.resolveRecovery("save-local-copy");
    session.completeRecovery("confirmed", "drawings/a-recovered.svg");
    await expect(recovery).resolves.toEqual({
      confirmed: true,
      savedPath: "drawings/a-recovered.svg",
    });
    expect(session.disposed).toBe(true);
    expect(harness.sessions).toHaveLength(2);
    harness.sessions[1]?.completeUnlock();
    await expect(waiting.outcome).resolves.toMatchObject({ kind: "activated" });
  });

  it("forwards host completion hooks to the recovery session", async () => {
    const harness = createHarness();
    const session = await enterHeadlessRecovery(harness);
    const reportSavedPath = vi.fn();
    const recovery = harness.coordinator.resolveRecovery("save-local-copy", { reportSavedPath });

    expect(session.recoveries[0]?.completion?.reportSavedPath).toBe(reportSavedPath);
    session.completeRecovery("confirmed", "drawings/a-recovered.svg");
    await expect(recovery).resolves.toMatchObject({ confirmed: true });
  });

  it("rejects a headless reload result after recovery is reattached", async () => {
    const harness = createHarness();
    const session = await enterHeadlessRecovery(harness);
    const recovery = harness.coordinator.resolveRecovery("reload-external");
    harness.coordinator.mountAttachment(documentASecondView);
    const reattached = harness.coordinator.requestActivation(documentASecondView);
    await expect(reattached.outcome).resolves.toMatchObject({
      disposition: "reattached",
      phase: "save-error",
      sessionId: session.snapshot.sessionId,
    });
    expect(session.cancelled).toEqual([session.recoveries[0]?.operation]);
    expect(harness.coordinator.getSnapshot().current?.attachment).toEqual({
      attachmentGeneration: documentASecondView.attachmentGeneration,
      attachmentId: documentASecondView.attachmentId,
    });

    session.completeRecovery();
    await expect(recovery).resolves.toEqual({ confirmed: false });
    expect(harness.coordinator.getSnapshot().current?.phase).toBe("save-error");
    expect(session.disposed).toBe(false);
    expect(harness.sessions).toHaveLength(1);
    expect(harness.release).toHaveBeenCalledTimes(1);
  });
});

describe("WorkspaceEditorCoordinator recovery race guards", () => {
  it("cancels attached recovery before handing the session to another view", async () => {
    const harness = createHarness();
    const { activation: blocked, session } = await prepareAttachedRecovery(harness);

    const recovery = harness.coordinator.resolveRecovery("save-local-copy");
    const recoveryOperation = session.recoveries[0]?.operation;
    expect(recoveryOperation).toMatchObject({
      attachment: {
        attachmentGeneration: documentA.attachmentGeneration,
        attachmentId: documentA.attachmentId,
      },
      baseRevision: 2,
      workspaceToken: blocked.token,
    });

    harness.coordinator.mountAttachment(documentASecondView);
    const handoff = harness.coordinator.requestActivation(documentASecondView);
    await expect(blocked.outcome).resolves.toMatchObject({ reason: "superseded" });
    await expect(handoff.outcome).resolves.toMatchObject({
      disposition: "same-document-handoff",
      phase: "save-error",
    });
    expect(session.cancelled).toContain(recoveryOperation);

    session.completeRecovery("confirmed", "drawings/a-recovered.svg");
    await expect(recovery).resolves.toEqual({ confirmed: false });
    expect(harness.coordinator.getSnapshot().current).toMatchObject({
      attachment: {
        attachmentGeneration: documentASecondView.attachmentGeneration,
        attachmentId: documentASecondView.attachmentId,
      },
      phase: "save-error",
    });
    expect(session.disposed).toBe(false);
    expect(harness.sessions).toHaveLength(1);
    expect(harness.release).toHaveBeenCalledTimes(1);
  });

  it("rejects a recovery result when the editor revision no longer matches its base", async () => {
    const harness = createHarness();
    const session = await enterHeadlessRecovery(harness);
    const recovery = harness.coordinator.resolveRecovery("save-local-copy");
    expect(session.recoveries[0]?.operation.baseRevision).toBe(1);

    session.snapshot = { ...session.snapshot, revision: 2 };
    session.completeRecovery("confirmed", "drawings/a-recovered.svg");

    await expect(recovery).resolves.toEqual({ confirmed: false });
    expect(harness.coordinator.getSnapshot().current?.phase).toBe("headless-recovery");
    expect(session.disposed).toBe(false);
  });
});

describe("WorkspaceEditorCoordinator attached recovery actions", () => {
  it("cancels attached recovery and allows a later retry", async () => {
    const harness = createHarness();
    const { activation: cancelledTarget, session } = await prepareAttachedRecovery(harness);

    expect(harness.attachedRecoveryRequired).toHaveBeenCalledWith({
      attachmentGeneration: documentA.attachmentGeneration,
      attachmentId: documentA.attachmentId,
      documentId: documentA.documentId,
      phase: "save-error",
      sessionId: session.snapshot.sessionId,
    });

    expect(harness.coordinator.cancelAttachedRecovery()).toBe(true);
    await expect(cancelledTarget.outcome).resolves.toMatchObject({ reason: "recovery-cancelled" });
    const waiting = harness.coordinator.requestActivation(documentB);
    session.completeSave("failed");
    await Promise.resolve();
    expect(harness.coordinator.retryRecovery()).toBe(true);
    session.completeSave();
    await Promise.resolve();
    harness.sessions[1]?.completeUnlock();
    await expect(waiting.outcome).resolves.toMatchObject({ kind: "activated" });
  });
});

describe("WorkspaceEditorCoordinator stale outcomes and cleanup", () => {
  it("starts a successor save when confirmation is not for the latest revision", async () => {
    const harness = createHarness();
    const session = await activate(harness, documentA);
    session.snapshot = { ...session.snapshot, dirty: true, revision: 1 };
    harness.coordinator.mountAttachment(documentB);
    harness.coordinator.requestActivation(documentB);
    const firstSave = session.locks[0];
    if (firstSave === undefined) {
      throw new Error("Expected a save");
    }
    session.snapshot = { ...session.snapshot, dirty: true, revision: 2 };
    firstSave.deferred.resolve({ ...firstSave.operation, revision: 1, status: "confirmed" });
    await Promise.resolve();

    expect(session.locks).toHaveLength(2);
    expect(harness.coordinator.getSnapshot().current?.phase).toBe("locking");
  });

  it("cleans up idempotently and rejects all later work", async () => {
    const harness = createHarness();
    expect(harness.coordinator.retryRecovery()).toBe(false);
    expect(harness.coordinator.cancelAttachedRecovery()).toBe(false);
    const invalidRecovery = harness.coordinator.resolveRecovery("reload-external");
    await expect(invalidRecovery).resolves.toEqual({ confirmed: false });
    harness.coordinator.dispose();
    harness.coordinator.dispose();
    expect(harness.coordinator.mountAttachment(documentA)).toBe(false);
    const afterDispose = harness.coordinator.requestActivation(documentA);
    await expect(afterDispose.outcome).resolves.toMatchObject({
      reason: "coordinator-disposed",
    });
  });

  it("hands dirty persistence to best-effort unload preparation", async () => {
    const harness = createHarness();
    const session = await activate(harness, documentA);
    session.snapshot = { ...session.snapshot, dirty: true, revision: 1 };

    harness.coordinator.dispose({ preparePersistence: true });

    expect(session.preparedForUnload).toBe(true);
    expect(session.disposed).toBe(false);
    expect(harness.coordinator.getSnapshot().current).toBeUndefined();
  });

  it("rejects stale async identities and cleanup rejects their later completion", async () => {
    const harness = createHarness();
    harness.coordinator.mountAttachment(documentA);
    const activation = harness.coordinator.requestActivation(documentA);
    const session = harness.sessions[0];
    const pending = session?.unlocks[0];
    if (session === undefined || pending === undefined) {
      throw new Error("Expected an unlock");
    }
    pending.deferred.resolve({ ...pending.operation, status: "active", workerEpoch: 99 });
    await Promise.resolve();
    expect(harness.coordinator.getSnapshot().current?.phase).toBe("unlocking");

    harness.coordinator.dispose();
    await expect(activation.outcome).resolves.toMatchObject({
      kind: "cancelled",
      reason: "coordinator-disposed",
    });
    expect(session.disposed).toBe(true);
    expect(harness.release).toHaveBeenCalledOnce();
  });
});
