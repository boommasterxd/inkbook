import { describe, expect, it, vi } from "vitest";

import {
  activate,
  createHarness,
  documentA,
  documentASecondView,
  documentB,
  documentC,
  enterHeadlessRecovery,
} from "./workspace-editor-coordinator-fixture";

describe("WorkspaceEditorCoordinator", () => {
  it("locks the attached editor only after cancelling input and confirming its latest save", async () => {
    const harness = createHarness();
    const session = await activate(harness, documentA);

    expect(harness.coordinator.requestLockCurrent()).toBe(true);
    expect(harness.coordinator.getSnapshot().current?.phase).toBe("locking");
    expect(harness.cancelGesture).toHaveBeenCalledWith({
      attachmentGeneration: documentA.attachmentGeneration,
      attachmentId: documentA.attachmentId,
    });
    expect(harness.disableInput).toHaveBeenCalledWith({
      attachmentGeneration: documentA.attachmentGeneration,
      attachmentId: documentA.attachmentId,
    });
    expect(session.locks).toHaveLength(1);

    session.completeSave();
    await vi.waitFor(() => {
      expect(harness.release).toHaveBeenCalledOnce();
    });

    expect(session.disposed).toBe(true);
    expect(harness.coordinator.getSnapshot().current).toBeUndefined();
    expect(harness.coordinator.requestLockCurrent()).toBe(false);
  });
});

describe("WorkspaceEditorCoordinator activation", () => {
  it("binds unlock to the mounted preview identity and reports a changed source", async () => {
    const harness = createHarness();
    const previewContentIdentity = { outputHash: "a".repeat(64), revision: 7 };
    const actualSourceIdentity = { outputHash: "b".repeat(64), revision: 8 };
    const target = { ...documentA, previewContentIdentity };
    harness.coordinator.mountAttachment(target);

    const activation = harness.coordinator.requestActivation(target);
    expect(harness.sessions[0]?.unlocks[0]?.operation.expectedSourceIdentity).toEqual(
      previewContentIdentity,
    );
    harness.sessions[0]?.completeSourceChanged(actualSourceIdentity);

    await expect(activation.outcome).resolves.toMatchObject({
      actualSourceIdentity,
      kind: "source-changed",
    });
    expect(harness.coordinator.getSnapshot().current?.phase).toBe("load-error");
  });

  it("rejects unmounted requests and assigns monotonically increasing tokens", async () => {
    const harness = createHarness();
    const stale = harness.coordinator.requestActivation(documentA);
    harness.coordinator.mountAttachment(documentA);
    const current = harness.coordinator.requestActivation(documentA);

    await expect(stale.outcome).resolves.toEqual({
      kind: "cancelled",
      reason: "stale-attachment",
      token: stale.token,
    });
    expect(current.token).toBeGreaterThan(stale.token);
    harness.sessions[0]?.completeUnlock();
    await expect(current.outcome).resolves.toMatchObject({
      disposition: "new-session",
      kind: "activated",
    });
  });

  it("hands one session to another presentation of the same document", async () => {
    const harness = createHarness();
    const session = await activate(harness, documentA);
    harness.coordinator.mountAttachment(documentASecondView);

    const handoff = harness.coordinator.requestActivation(documentASecondView);

    await expect(handoff.outcome).resolves.toMatchObject({
      disposition: "same-document-handoff",
      kind: "activated",
      sessionId: session.snapshot.sessionId,
    });
    expect(harness.sessions).toHaveLength(1);
    expect(harness.cancelGesture).toHaveBeenCalledWith({
      attachmentGeneration: 1,
      attachmentId: "attachment-a",
    });
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it("keeps only the latest pending document while one lock drains", async () => {
    const harness = createHarness();
    const first = await activate(harness, documentA);
    harness.coordinator.mountAttachment(documentB);
    harness.coordinator.mountAttachment(documentC);
    const superseded = harness.coordinator.requestActivation(documentB);
    const latest = harness.coordinator.requestActivation(documentC);
    const invalidTarget = { ...documentC, attachmentId: "never-mounted" };
    const invalid = harness.coordinator.requestActivation(invalidTarget);

    await expect(superseded.outcome).resolves.toMatchObject({
      kind: "cancelled",
      reason: "superseded",
    });
    await expect(invalid.outcome).resolves.toMatchObject({ reason: "stale-attachment" });
    expect(first.locks).toHaveLength(1);
    expect(harness.disableInput).toHaveBeenCalledOnce();

    first.completeSave();
    await Promise.resolve();
    expect(first.disposed).toBe(true);
    expect(harness.sessions).toHaveLength(2);
    harness.sessions[1]?.completeUnlock();
    await expect(latest.outcome).resolves.toMatchObject({ kind: "activated" });
  });

  it("cancels a pending request when its widget detaches", async () => {
    const harness = createHarness();
    const first = await activate(harness, documentA);
    harness.coordinator.mountAttachment(documentB);
    const pending = harness.coordinator.requestActivation(documentB);

    harness.coordinator.detachAttachment(documentB);
    await expect(pending.outcome).resolves.toMatchObject({
      kind: "cancelled",
      reason: "attachment-detached",
    });
    expect(first.locks).toHaveLength(1);
  });
});

describe("WorkspaceEditorCoordinator lifecycle soak", () => {
  it("releases every superseded session across repeated note switches", async () => {
    const harness = createHarness();
    let current = await activate(harness, documentA);
    harness.coordinator.mountAttachment(documentB);

    for (let cycle = 0; cycle < 20; cycle += 1) {
      const target = cycle % 2 === 0 ? documentB : documentA;
      const activation = harness.coordinator.requestActivation(target);
      current.completeSave();
      await Promise.resolve();
      const next = harness.sessions[harness.sessions.length - 1];
      if (next === undefined) throw new Error("Expected a successor session.");
      next.completeUnlock();
      await expect(activation.outcome).resolves.toMatchObject({ kind: "activated" });
      current = next;
    }

    harness.coordinator.dispose();
    expect(harness.sessions).toHaveLength(21);
    expect(harness.sessions.every(({ disposed }) => disposed)).toBe(true);
    expect(harness.coordinator.getSnapshot().current).toBeUndefined();
  });
});

describe("WorkspaceEditorCoordinator activation races", () => {
  it("adopts an unlock completed by a session fallback executor", async () => {
    const harness = createHarness();
    harness.coordinator.mountAttachment(documentA);
    const activation = harness.coordinator.requestActivation(documentA);
    const session = harness.sessions[0];
    if (session === undefined) throw new Error("Expected a fallback session.");
    const pending = session.unlocks[0];
    if (pending === undefined) throw new Error("Expected a fallback unlock operation.");
    session.snapshot = { ...session.snapshot, workerEpoch: 2 };

    pending.deferred.resolve({ ...pending.operation, status: "active", workerEpoch: 2 });

    await expect(activation.outcome).resolves.toMatchObject({
      kind: "activated",
      sessionId: session.snapshot.sessionId,
    });
    expect(harness.coordinator.getSnapshot().current?.phase).toBe("active");
  });

  it("supersedes a duplicate request while the same attachment is unlocking", async () => {
    const harness = createHarness();
    harness.coordinator.mountAttachment(documentA);
    const first = harness.coordinator.requestActivation(documentA);
    const second = harness.coordinator.requestActivation(documentA);

    await expect(first.outcome).resolves.toMatchObject({ reason: "superseded" });
    harness.sessions[0]?.completeUnlock();
    await expect(second.outcome).resolves.toMatchObject({
      disposition: "already-current",
      kind: "activated",
    });
  });

  it("cancels a clean unlock before starting the latest document", async () => {
    const harness = createHarness();
    harness.coordinator.mountAttachment(documentA);
    const first = harness.coordinator.requestActivation(documentA);
    const firstSession = harness.sessions[0];
    harness.coordinator.mountAttachment(documentB);
    const second = harness.coordinator.requestActivation(documentB);

    await expect(first.outcome).resolves.toMatchObject({ reason: "superseded" });
    expect(firstSession?.cancelled).toHaveLength(1);
    expect(firstSession?.disposed).toBe(true);
    harness.sessions[1]?.completeUnlock();
    await expect(second.outcome).resolves.toMatchObject({ kind: "activated" });
  });

  it("cancels and releases an unlocking session when its attachment detaches", async () => {
    const harness = createHarness();
    harness.coordinator.mountAttachment(documentA);
    const activation = harness.coordinator.requestActivation(documentA);
    const session = harness.sessions[0];

    harness.coordinator.detachAttachment(documentA);

    await expect(activation.outcome).resolves.toMatchObject({ reason: "attachment-detached" });
    expect(session?.cancelled).toHaveLength(1);
    expect(session?.disposed).toBe(true);
    expect(harness.coordinator.getSnapshot().current).toBeUndefined();
  });

  it("releases a load-error session before unlocking another document", async () => {
    const harness = createHarness();
    harness.coordinator.mountAttachment(documentA);
    const failed = harness.coordinator.requestActivation(documentA);
    harness.sessions[0]?.completeUnlock("load-error");
    await expect(failed.outcome).resolves.toMatchObject({ kind: "load-error" });
    harness.coordinator.mountAttachment(documentB);
    const next = harness.coordinator.requestActivation(documentB);

    expect(harness.sessions[0]?.disposed).toBe(true);
    harness.sessions[1]?.completeUnlock();
    await expect(next.outcome).resolves.toMatchObject({ kind: "activated" });
  });
});

describe("WorkspaceEditorCoordinator load errors", () => {
  it("retries a load error in the same session and can discard it", async () => {
    const harness = createHarness();
    harness.coordinator.mountAttachment(documentA);
    const failed = harness.coordinator.requestActivation(documentA);
    const session = harness.sessions[0];
    session?.completeUnlock("load-error");
    await expect(failed.outcome).resolves.toMatchObject({ kind: "load-error" });

    const retry = harness.coordinator.requestActivation(documentA);
    expect(harness.sessions).toHaveLength(1);
    expect(session?.unlocks).toHaveLength(2);
    session?.completeUnlock();
    await expect(retry.outcome).resolves.toMatchObject({
      disposition: "already-current",
      kind: "activated",
    });

    const secondHarness = createHarness();
    secondHarness.coordinator.mountAttachment(documentA);
    const discarded = secondHarness.coordinator.requestActivation(documentA);
    secondHarness.sessions[0]?.completeUnlock("load-error");
    await expect(discarded.outcome).resolves.toMatchObject({ kind: "load-error" });
    expect(secondHarness.coordinator.dismissLoadError()).toBe(true);
    expect(secondHarness.sessions[0]?.disposed).toBe(true);
    expect(secondHarness.release).toHaveBeenCalledOnce();
    expect(secondHarness.coordinator.getSnapshot().current).toBeUndefined();
  });
});

describe("WorkspaceEditorCoordinator detached ownership", () => {
  it("releases a clean session immediately on detachment", async () => {
    const harness = createHarness();
    const session = await activate(harness, documentA);

    harness.coordinator.detachAttachment(documentA);

    expect(session.disposed).toBe(true);
    expect(session.locks).toHaveLength(0);
    expect(harness.coordinator.getSnapshot().current).toBeUndefined();
  });

  it("retains and reattaches a dirty detached session while its save continues", async () => {
    const harness = createHarness();
    const session = await activate(harness, documentA);
    session.snapshot = {
      ...session.snapshot,
      dirty: true,
      persistencePending: true,
      revision: 3,
    };

    harness.coordinator.detachAttachment(documentA);
    expect(harness.coordinator.getSnapshot().current?.phase).toBe("detached-saving");
    expect(session.disposed).toBe(false);
    expect(session.locks).toHaveLength(1);

    harness.coordinator.mountAttachment(documentASecondView);
    const reattached = harness.coordinator.requestActivation(documentASecondView);
    await expect(reattached.outcome).resolves.toMatchObject({
      disposition: "reattached",
      kind: "activated",
    });
    session.completeSave();
    await Promise.resolve();
    expect(harness.coordinator.getSnapshot().current?.phase).toBe("active");
    expect(session.disposed).toBe(false);
  });

  it("keeps failed detached saves in headless recovery and blocks other documents", async () => {
    const harness = createHarness();
    await enterHeadlessRecovery(harness);

    expect(harness.coordinator.getSnapshot().current?.phase).toBe("headless-recovery");
    expect(harness.headlessRecoveryRequired).toHaveBeenCalledOnce();
    harness.coordinator.mountAttachment(documentB);
    const blocked = harness.coordinator.requestActivation(documentB);
    expect(harness.coordinator.getSnapshot().pending?.token).toBe(blocked.token);
    expect(harness.sessions).toHaveLength(1);

    harness.coordinator.mountAttachment(documentASecondView);
    const recovery = harness.coordinator.requestActivation(documentASecondView);
    await expect(blocked.outcome).resolves.toMatchObject({ reason: "superseded" });
    await expect(recovery.outcome).resolves.toMatchObject({ phase: "save-error" });
  });
});
