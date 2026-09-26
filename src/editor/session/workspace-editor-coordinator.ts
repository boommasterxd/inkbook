import type {
  DocumentSessionSnapshot,
  ExternalChangeOutcome,
  RecoveryCompletionPort,
  RecoveryOperationIdentity,
  PresentationLifecyclePort,
  RecoveryResult,
  SaveResult,
  SessionFactory,
  SessionOperationIdentity,
  UnlockResult,
  WorkspaceSessionNotifications,
} from "./session-port";
import { observeSave, observeUnlock, requestRecovery } from "./session-operation-outcomes";
import { isAttachedSession, transitionSession, type AttachmentIdentity } from "./session-state";
import {
  cancelActivationRecord,
  cancelRecoveryOperation,
  canResolveRecovery,
  createActivationRecord,
  createCurrentSession,
  hasAttachment,
  isCurrentActivation,
  notifyHeadlessRecovery,
  NOOP_NOTIFICATIONS,
  projectCurrent,
  sameTarget,
  type ActivationRecord,
  type CurrentSession,
  AttachmentRegistry,
  SessionOperationTracker,
} from "./workspace-editor-coordinator-model";
import { handoffSession, tryActivateSameAttachment } from "./workspace-session-activation";
import {
  adoptRecoveryResult,
  isCurrentExternalOperation,
  releasePresentation,
  requestExternalChange,
  stopPresentation,
} from "./workspace-session-recovery";
import { adoptSaveResult, adoptUnlockResult } from "./workspace-session-outcomes";
import type {
  ActivationCancellationReason,
  ActivationHandle,
  ActivationTarget,
  WorkspaceEditorCoordinatorOptions,
  WorkspaceEditorCoordinatorSnapshot,
} from "./workspace-editor-coordinator-types";

export class WorkspaceEditorCoordinator {
  readonly #attachments = new AttachmentRegistry();
  readonly #createSessionId: () => string;
  readonly #notifications: WorkspaceSessionNotifications;
  readonly #presentations: PresentationLifecyclePort;
  readonly #sessions: SessionFactory;
  #current: CurrentSession | undefined;
  #disposed = false;
  #nextWorkspaceToken = 0;
  readonly #operations = new SessionOperationTracker();
  #pending: ActivationRecord | undefined;
  #sessionId = 0;
  #workspaceToken = 0;

  constructor(options: WorkspaceEditorCoordinatorOptions) {
    this.#sessions = options.sessions;
    this.#presentations = options.presentations;
    this.#notifications = options.notifications ?? NOOP_NOTIFICATIONS;
    this.#createSessionId =
      options.createSessionId ?? (() => `inkbook-session-${++this.#sessionId}`);
  }

  mountAttachment(target: ActivationTarget): boolean {
    return !this.#disposed && this.#attachments.mount(target);
  }

  requestActivation(target: ActivationTarget): ActivationHandle {
    const record = createActivationRecord(target, ++this.#nextWorkspaceToken);
    if (this.#disposed) {
      cancelActivationRecord(record, "coordinator-disposed");
    } else if (!this.#attachments.isMounted(target)) {
      cancelActivationRecord(record, "stale-attachment");
    } else {
      this.#workspaceToken = record.token;
      if (this.#current?.port.getSnapshot().documentId === target.documentId) {
        this.#activateExistingSession(record);
      } else {
        this.#queueDifferentDocument(record);
      }
    }
    return { outcome: record.outcome, token: record.token };
  }

  dismissLoadError(): boolean {
    const current = this.#current;
    if (current === undefined || current.state.phase !== "load-error") return false;
    const attachment = current.state.attachment;
    current.state = transitionSession(current.state, "dismiss-load-error");
    this.#releaseTerminalSession(current, attachment);
    return true;
  }

  detachAttachment(target: ActivationTarget): void {
    if (!this.#attachments.unmount(target)) {
      return;
    }
    if (this.#pending !== undefined && sameTarget(this.#pending.target, target)) {
      this.#cancelPending("attachment-detached");
    }

    const current = this.#current;
    if (current === undefined || !hasAttachment(current, target)) {
      return;
    }
    this.#presentations.cancelGesture(current.state.attachment);
    this.#presentations.release(current.state.attachment);
    if (current.activation !== undefined) {
      cancelActivationRecord(current.activation, "attachment-detached");
      current.activation = undefined;
    }
    this.#detachCurrent(current);
  }

  requestLockCurrent(): boolean {
    const current = this.#current;
    if (current === undefined || current.state.phase !== "active") {
      return false;
    }
    this.#presentations.cancelGesture(current.state.attachment);
    this.#presentations.disableInput(current.state.attachment);
    current.state = transitionSession(current.state, "start-lock");
    this.#startSave(current);
    return true;
  }

  async notifyExternalChange(documentId: string): Promise<ExternalChangeOutcome | "ignored"> {
    const current = this.#current;
    if (current === undefined || !canObserveExternalChange(current, documentId)) return "ignored";
    const operation = this.#operations.create(current, this.#workspaceToken);
    return requestExternalChange({
      current,
      isCurrent: (candidate) =>
        isCurrentExternalOperation(
          this.#current,
          current,
          candidate,
          this.#disposed,
          this.#workspaceToken,
        ),
      notifications: this.#notifications,
      operation,
      releasePresentation: () => releasePresentation(this.#presentations, current),
      stopPresentation: () => stopPresentation(this.#presentations, current),
    });
  }

  retryRecovery(): boolean {
    const current = this.#current;
    if (
      current === undefined ||
      (current.state.phase !== "save-error" && current.state.phase !== "headless-recovery")
    ) {
      return false;
    }
    cancelRecoveryOperation(current);
    current.state = transitionSession(current.state, "retry-save");
    this.#startSave(current);
    return true;
  }

  cancelAttachedRecovery(): boolean {
    const current = this.#current;
    if (current === undefined || current.state.phase !== "save-error") {
      return false;
    }
    cancelRecoveryOperation(current);
    current.state = transitionSession(current.state, "cancel-recovery");
    this.#cancelPending("recovery-cancelled");
    return true;
  }

  async resolveRecovery(
    action: "reload-external" | "save-local-copy",
    completion?: RecoveryCompletionPort,
  ) {
    const current = this.#current;
    if (!canResolveRecovery(current?.state, action)) {
      return { confirmed: false };
    }
    cancelRecoveryOperation(current);
    const operation = this.#operations.createRecovery(current, this.#workspaceToken);
    current.recoveryOperation = operation;
    const result = await requestRecovery(current.port, action, operation, completion);
    return this.#adoptRecoveryResult(current, action, operation, result);
  }

  getSnapshot(): WorkspaceEditorCoordinatorSnapshot {
    const current = this.#current;
    const pending = this.#pending;
    return {
      ...(current === undefined ? {} : { current: projectCurrent(current) }),
      disposed: this.#disposed,
      ...(pending === undefined
        ? {}
        : { pending: { target: pending.target, token: pending.token } }),
    };
  }

  dispose(options: { readonly preparePersistence?: boolean } = {}): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#attachments.clear();
    this.#cancelPending("coordinator-disposed");
    const current = this.#current;
    if (current === undefined) {
      return;
    }
    if (isAttachedSession(current.state)) {
      this.#presentations.cancelGesture(current.state.attachment);
      this.#presentations.release(current.state.attachment);
    }
    if (current.activation !== undefined) {
      cancelActivationRecord(current.activation, "coordinator-disposed");
    }
    this.#releaseCurrent(current, true, options.preparePersistence === true);
  }

  #activateExistingSession(record: ActivationRecord): void {
    this.#cancelPending("superseded");
    const current = this.#current;
    if (current === undefined) {
      this.#queueDifferentDocument(record);
      return;
    }
    if (
      tryActivateSameAttachment({
        adoptUnlock: (operation, result) => this.#adoptUnlockResult(current, operation, result),
        createOperation: () => this.#operations.create(current, record.token, record.target),
        current,
        record,
      })
    ) {
      return;
    }
    handoffSession({
      current,
      notifications: this.#notifications,
      presentations: this.#presentations,
      record,
    });
  }

  #queueDifferentDocument(record: ActivationRecord): void {
    this.#cancelPending("superseded");
    this.#pending = record;
    const current = this.#current;
    if (current === undefined) {
      this.#activatePending();
      return;
    }
    if (current.state.phase === "unlocking") {
      this.#cancelUnlockAndRelease(current);
      return;
    }
    if (current.state.phase === "load-error") {
      this.#releaseAttachedCurrent(current);
      return;
    }
    if (current.state.phase === "active") {
      this.#presentations.cancelGesture(current.state.attachment);
      this.#presentations.disableInput(current.state.attachment);
      current.state = transitionSession(current.state, "start-lock");
      this.#startSave(current);
    }
  }

  #activatePending(): void {
    const pending = this.#pending;
    if (pending === undefined || this.#disposed) {
      return;
    }
    this.#pending = undefined;
    if (!this.#attachments.isMounted(pending.target) || pending.token !== this.#workspaceToken) {
      cancelActivationRecord(pending, "stale-attachment");
      return;
    }
    const current = createCurrentSession(pending, this.#createSessionId(), this.#sessions);
    this.#current = current;
    const operation = this.#operations.create(current, pending.token, pending.target);
    current.unlockOperation = operation;
    observeUnlock(current.port, operation, (result) => {
      this.#adoptUnlockResult(current, operation, result);
    });
  }

  #adoptUnlockResult(
    current: CurrentSession,
    operation: SessionOperationIdentity,
    result: UnlockResult,
  ): void {
    const outcome = adoptUnlockResult({
      activationIsCurrent: (activation) =>
        isCurrentActivation(
          this.#attachments,
          this.#current,
          current,
          activation,
          this.#workspaceToken,
        ),
      current,
      operationIsCurrent: this.#isCurrentOperation(
        current,
        current.unlockOperation,
        operation,
        result,
      ),
      result,
    });
    if (outcome === "release") {
      this.#releaseCurrent(current, false);
      this.#activatePending();
    }
  }

  #startSave(current: CurrentSession): void {
    if (current.saveOperation !== undefined || this.#current !== current) {
      return;
    }
    const operation = this.#operations.create(current, this.#workspaceToken);
    current.saveOperation = operation;
    observeSave(current.port, operation, (result) => {
      this.#adoptSaveResult(current, operation, result);
    });
  }

  #adoptSaveResult(
    current: CurrentSession,
    operation: SessionOperationIdentity,
    result: SaveResult,
  ): void {
    const attachment = isAttachedSession(current.state) ? current.state.attachment : undefined;
    const outcome = adoptSaveResult({
      current,
      notifications: this.#notifications,
      operationIsCurrent: this.#isCurrentOperation(
        current,
        current.saveOperation,
        operation,
        result,
      ),
      result,
    });
    if (outcome === "restart") {
      this.#startSave(current);
    } else if (outcome === "release") {
      this.#releaseTerminalSession(current, attachment);
    }
  }

  #adoptRecoveryResult(
    current: CurrentSession,
    action: "reload-external" | "save-local-copy",
    operation: RecoveryOperationIdentity,
    result: RecoveryResult,
  ) {
    const isCurrent = this.#operations.matchesRecovery(
      this.#current,
      current,
      current.recoveryOperation,
      operation,
      result,
      { disposed: this.#disposed, workspaceToken: this.#workspaceToken },
    );
    const attachment = isAttachedSession(current.state) ? current.state.attachment : undefined;
    return adoptRecoveryResult({
      action,
      current,
      isCurrent,
      notifications: this.#notifications,
      operation,
      release: () => this.#releaseTerminalSession(current, attachment),
      result,
    });
  }

  #detachCurrent(current: CurrentSession): void {
    cancelRecoveryOperation(current);
    const snapshot = current.port.getSnapshot();
    if (current.state.phase === "unlocking") {
      this.#cancelUnlockAndRelease(current);
    } else if (current.state.phase === "load-error") {
      current.state = transitionSession(current.state, "detach-clean");
      this.#releaseCurrent(current, false);
      this.#activatePending();
    } else if (current.state.phase === "save-error") {
      current.state = transitionSession(current.state, "detach-dirty");
      notifyHeadlessRecovery(current, this.#notifications);
    } else if (current.state.phase === "locking") {
      current.state = transitionSession(current.state, "detach-dirty");
    } else if (current.state.phase === "active") {
      this.#detachActive(current, snapshot);
    }
  }

  #detachActive(current: CurrentSession, snapshot: DocumentSessionSnapshot): void {
    if (snapshot.dirty || snapshot.persistencePending || current.saveOperation !== undefined) {
      current.state = transitionSession(current.state, "detach-dirty");
      this.#startSave(current);
      return;
    }
    current.state = transitionSession(current.state, "detach-clean");
    this.#releaseCurrent(current, false);
    this.#activatePending();
  }

  #cancelUnlockAndRelease(current: CurrentSession): void {
    if (current.unlockOperation !== undefined) {
      current.port.cancelOperation(current.unlockOperation);
      current.unlockOperation = undefined;
    }
    if (current.activation !== undefined) {
      cancelActivationRecord(current.activation, "superseded");
      current.activation = undefined;
    }
    if (current.state.phase === "unlocking") {
      current.state = transitionSession(current.state, "unlock-cancelled");
    }
    this.#releaseCurrent(current, false);
    this.#activatePending();
  }

  #releaseAttachedCurrent(current: CurrentSession): void {
    if (isAttachedSession(current.state)) {
      this.#presentations.cancelGesture(current.state.attachment);
      this.#presentations.release(current.state.attachment);
    }
    this.#releaseCurrent(current, false);
    this.#activatePending();
  }

  #releaseTerminalSession(current: CurrentSession, priorAttachment?: AttachmentIdentity): void {
    const attachment = isAttachedSession(current.state)
      ? current.state.attachment
      : priorAttachment;
    if (attachment !== undefined) this.#presentations.release(attachment);
    this.#releaseCurrent(current, false);
    this.#activatePending();
  }

  #releaseCurrent(current: CurrentSession, unload: boolean, preparePersistence = false): void {
    if (this.#current !== current) {
      return;
    }
    current.state = unload ? transitionSession(current.state, "plugin-unload") : current.state;
    if (preparePersistence && current.port.prepareForUnload !== undefined) {
      void current.port.prepareForUnload();
    } else {
      current.port.dispose();
    }
    this.#current = undefined;
  }

  #isCurrentOperation(
    current: CurrentSession,
    expected: SessionOperationIdentity | undefined,
    operation: SessionOperationIdentity,
    result: SessionOperationIdentity,
  ): boolean {
    return this.#operations.matches(
      this.#current,
      current,
      expected,
      operation,
      result,
      this.#disposed,
    );
  }

  #cancelPending(reason: ActivationCancellationReason): void {
    if (this.#pending === undefined) {
      return;
    }
    cancelActivationRecord(this.#pending, reason);
    this.#pending = undefined;
  }
}

function canObserveExternalChange(current: CurrentSession, documentId: string): boolean {
  return (
    current.port.getSnapshot().documentId === documentId &&
    current.port.notifyExternalChange !== undefined &&
    current.state.phase === "active"
  );
}
