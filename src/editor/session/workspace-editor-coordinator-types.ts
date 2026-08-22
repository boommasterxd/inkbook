import type {
  PresentationLifecyclePort,
  SessionFactory,
  WorkspaceSessionNotifications,
} from "./session-port";
import type { AttachmentIdentity, SessionState } from "./session-state";

export interface ActivationTarget extends AttachmentIdentity {
  readonly documentId: string;
}

export type ActivationCancellationReason =
  | "attachment-detached"
  | "coordinator-disposed"
  | "recovery-cancelled"
  | "stale-attachment"
  | "superseded";

export type ActivationOutcome =
  | {
      readonly disposition:
        "already-current" | "new-session" | "reattached" | "same-document-handoff";
      readonly kind: "activated";
      readonly phase: "active" | "locking" | "save-error";
      readonly sessionId: string;
      readonly token: number;
    }
  | {
      readonly kind: "cancelled";
      readonly reason: ActivationCancellationReason;
      readonly token: number;
    }
  | {
      readonly kind: "load-error";
      readonly sessionId: string;
      readonly token: number;
    };

export interface ActivationHandle {
  readonly outcome: Promise<ActivationOutcome>;
  readonly token: number;
}

export type RecoveryResolution =
  { readonly confirmed: false } | { readonly confirmed: true; readonly savedPath?: string };

export interface WorkspaceEditorCoordinatorOptions {
  readonly createSessionId?: () => string;
  readonly notifications?: WorkspaceSessionNotifications;
  readonly presentations: PresentationLifecyclePort;
  readonly sessions: SessionFactory;
}

export interface WorkspaceEditorCoordinatorSnapshot {
  readonly current?: {
    readonly attachment?: AttachmentIdentity;
    readonly dirty: boolean;
    readonly documentId: string;
    readonly persistencePending: boolean;
    readonly phase: SessionState["phase"];
    readonly revision: number;
    readonly sessionId: string;
  };
  readonly disposed: boolean;
  readonly pending?: {
    readonly target: ActivationTarget;
    readonly token: number;
  };
}
