import type { AttachmentIdentity, SessionPhase } from "./session-state";

export interface SessionIdentity {
  readonly documentId: string;
  readonly sessionId: string;
}

export interface SessionOperationIdentity extends SessionIdentity {
  readonly operationId: number;
  readonly workerEpoch: number;
  readonly workspaceToken: number;
}

export interface RecoveryOperationIdentity extends SessionOperationIdentity {
  readonly attachment?: AttachmentIdentity;
  readonly baseRevision: number;
}

export interface DocumentSessionSnapshot extends SessionIdentity {
  readonly confirmedRevision: number;
  readonly dirty: boolean;
  readonly persistencePending: boolean;
  readonly revision: number;
  readonly workerEpoch: number;
}

export interface UnlockResult extends SessionOperationIdentity {
  readonly status: "active" | "load-error";
}

export interface SaveResult extends SessionOperationIdentity {
  readonly revision: number;
  readonly status: "confirmed" | "failed";
}

export interface RecoveryResult extends RecoveryOperationIdentity {
  readonly savedPath?: string;
  readonly status: "confirmed" | "failed";
}

export interface RecoveryCompletionPort {
  readonly replaceMarkdownTarget?: (
    savedPath: string,
    isCurrent: () => boolean,
  ) => boolean | Promise<boolean>;
  readonly reportSavedPath?: (savedPath: string) => void;
}

export type ExternalChangeOutcome = "conflict" | "reload-failed" | "reload-required" | "reloaded";

export interface DocumentSessionPort {
  cancelOperation(operation: SessionOperationIdentity): void;
  dispose(): void;
  getSnapshot(): DocumentSessionSnapshot;
  lockLatest(operation: SessionOperationIdentity): Promise<SaveResult>;
  notifyExternalChange?(operation: SessionOperationIdentity): Promise<ExternalChangeOutcome>;
  prepareForUnload?(): Promise<void>;
  resolveRecovery(
    action: "reload-external" | "save-local-copy",
    operation: RecoveryOperationIdentity,
    completion?: RecoveryCompletionPort,
  ): Promise<RecoveryResult>;
  unlock(operation: SessionOperationIdentity): Promise<UnlockResult>;
}

export interface SessionFactory {
  create(identity: SessionIdentity): DocumentSessionPort;
}

export interface PresentationLifecyclePort {
  cancelGesture(attachment: AttachmentIdentity): void;
  disableInput(attachment: AttachmentIdentity): void;
  release(attachment: AttachmentIdentity): void;
}

interface HeadlessRecoveryNotice {
  readonly documentId: string;
  readonly phase: Extract<SessionPhase, "headless-recovery">;
  readonly sessionId: string;
}

interface AttachedRecoveryNotice extends AttachmentIdentity {
  readonly documentId: string;
  readonly phase: Extract<SessionPhase, "save-error">;
  readonly sessionId: string;
}

export interface WorkspaceSessionNotifications {
  attachedRecoveryRequired(notice: AttachedRecoveryNotice): void;
  headlessRecoveryRequired(notice: HeadlessRecoveryNotice): void;
}
