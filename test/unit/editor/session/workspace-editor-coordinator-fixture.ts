import { expect, vi } from "vitest";

import type {
  DocumentSessionPort,
  DocumentSessionSnapshot,
  RecoveryOperationIdentity,
  RecoveryCompletionPort,
  RecoveryResult,
  SaveResult,
  SessionIdentity,
  SessionOperationIdentity,
  UnlockResult,
} from "../../../../src/editor/session/session-port";
import { WorkspaceEditorCoordinator } from "../../../../src/editor/session/workspace-editor-coordinator";
import type { ActivationTarget } from "../../../../src/editor/session/workspace-editor-coordinator-types";

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  return {
    promise: new Promise<Value>((complete) => {
      resolve = complete;
    }),
    resolve,
  };
}

export class FakeSession implements DocumentSessionPort {
  readonly cancelled: SessionOperationIdentity[] = [];
  disposed = false;
  preparedForUnload = false;
  externalChangeOutcome:
    "conflict" | "reload-failed" | "reload-required" | "reloaded" | "unchanged" = "reload-required";
  readonly locks: Array<{
    deferred: Deferred<SaveResult>;
    operation: SessionOperationIdentity;
  }> = [];
  readonly recoveries: Array<{
    action: "reload-external" | "save-local-copy";
    completion: RecoveryCompletionPort | undefined;
    deferred: Deferred<RecoveryResult>;
    operation: RecoveryOperationIdentity;
  }> = [];
  snapshot: DocumentSessionSnapshot;
  readonly unlocks: Array<{
    deferred: Deferred<UnlockResult>;
    operation: SessionOperationIdentity;
  }> = [];

  constructor(identity: SessionIdentity) {
    this.snapshot = {
      ...identity,
      confirmedRevision: 0,
      dirty: false,
      persistencePending: false,
      revision: 0,
      workerEpoch: 1,
    };
  }

  cancelOperation(operation: SessionOperationIdentity): void {
    this.cancelled.push(operation);
  }

  dispose(): void {
    this.disposed = true;
  }

  prepareForUnload(): Promise<void> {
    this.preparedForUnload = true;
    return Promise.resolve();
  }

  getSnapshot(): DocumentSessionSnapshot {
    return this.snapshot;
  }

  lockLatest(operation: SessionOperationIdentity): Promise<SaveResult> {
    const pending = deferred<SaveResult>();
    this.locks.push({ deferred: pending, operation });
    return pending.promise;
  }

  notifyExternalChange(): Promise<
    "conflict" | "reload-failed" | "reload-required" | "reloaded" | "unchanged"
  > {
    return Promise.resolve(this.externalChangeOutcome);
  }

  resolveRecovery(
    action: "reload-external" | "save-local-copy",
    operation: RecoveryOperationIdentity,
    completion?: RecoveryCompletionPort,
  ): Promise<RecoveryResult> {
    const pending = deferred<RecoveryResult>();
    this.recoveries.push({ action, completion, deferred: pending, operation });
    return pending.promise;
  }

  unlock(operation: SessionOperationIdentity): Promise<UnlockResult> {
    const pending = deferred<UnlockResult>();
    this.unlocks.push({ deferred: pending, operation });
    return pending.promise;
  }

  completeUnlock(status: UnlockResult["status"] = "active"): void {
    const pending = this.unlocks[this.unlocks.length - 1];
    if (pending === undefined) {
      throw new Error("No unlock is pending");
    }
    pending.deferred.resolve({ ...pending.operation, status });
  }

  completeSave(status: SaveResult["status"] = "confirmed"): void {
    const pending = this.locks[this.locks.length - 1];
    if (pending === undefined) {
      throw new Error("No save is pending");
    }
    if (status === "confirmed") {
      this.snapshot = {
        ...this.snapshot,
        confirmedRevision: this.snapshot.revision,
        dirty: false,
        persistencePending: false,
      };
    }
    pending.deferred.resolve({ ...pending.operation, revision: this.snapshot.revision, status });
  }

  completeRecovery(status: RecoveryResult["status"] = "confirmed", savedPath?: string): void {
    const pending = this.recoveries[this.recoveries.length - 1];
    if (pending === undefined) {
      throw new Error("No recovery is pending");
    }
    pending.deferred.resolve({
      ...pending.operation,
      ...(savedPath === undefined ? {} : { savedPath }),
      status,
    });
  }
}

export const documentA: ActivationTarget = {
  attachmentGeneration: 1,
  attachmentId: "attachment-a",
  documentId: "drawings/a.svg",
};
export const documentASecondView: ActivationTarget = {
  attachmentGeneration: 4,
  attachmentId: "attachment-a-second",
  documentId: "drawings/a.svg",
};
export const documentB: ActivationTarget = {
  attachmentGeneration: 2,
  attachmentId: "attachment-b",
  documentId: "drawings/b.svg",
};
export const documentC: ActivationTarget = {
  attachmentGeneration: 3,
  attachmentId: "attachment-c",
  documentId: "drawings/c.svg",
};

export function createHarness() {
  const sessions: FakeSession[] = [];
  const cancelGesture = vi.fn();
  const disableInput = vi.fn();
  const release = vi.fn();
  const attachedRecoveryRequired = vi.fn();
  const headlessRecoveryRequired = vi.fn();
  const coordinator = new WorkspaceEditorCoordinator({
    notifications: { attachedRecoveryRequired, headlessRecoveryRequired },
    presentations: { cancelGesture, disableInput, release },
    sessions: {
      create(identity) {
        const session = new FakeSession(identity);
        sessions.push(session);
        return session;
      },
    },
  });
  return {
    attachedRecoveryRequired,
    cancelGesture,
    coordinator,
    disableInput,
    headlessRecoveryRequired,
    release,
    sessions,
  };
}

export async function activate(
  harness: ReturnType<typeof createHarness>,
  target: ActivationTarget,
): Promise<FakeSession> {
  expect(harness.coordinator.mountAttachment(target)).toBe(true);
  const handle = harness.coordinator.requestActivation(target);
  const session = harness.sessions[harness.sessions.length - 1];
  if (session === undefined) {
    throw new Error("Expected a session");
  }
  session.completeUnlock();
  await expect(handle.outcome).resolves.toMatchObject({ kind: "activated", token: handle.token });
  return session;
}

export async function enterHeadlessRecovery(
  harness: ReturnType<typeof createHarness>,
): Promise<FakeSession> {
  const session = await activate(harness, documentA);
  session.snapshot = { ...session.snapshot, dirty: true, revision: 1 };
  harness.coordinator.detachAttachment(documentA);
  session.completeSave("failed");
  await Promise.resolve();
  return session;
}
