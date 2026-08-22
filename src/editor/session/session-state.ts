export interface AttachmentIdentity {
  readonly attachmentGeneration: number;
  readonly attachmentId: string;
}

type AttachedSessionPhase = "active" | "load-error" | "locking" | "save-error" | "unlocking";

export type SessionPhase =
  AttachedSessionPhase | "detached-saving" | "headless-recovery" | "locked" | "released";

export type SessionState =
  | {
      readonly attachment: AttachmentIdentity;
      readonly phase: AttachedSessionPhase;
    }
  | {
      readonly phase: "detached-saving" | "headless-recovery" | "locked" | "released";
    };

export type SessionTransition =
  | "cancel-recovery"
  | "detach-clean"
  | "detach-dirty"
  | "dismiss-load-error"
  | "load-failed"
  | "plugin-unload"
  | "reload-external"
  | "retry-load"
  | "retry-save"
  | "save-confirmed"
  | "save-failed"
  | "save-local-copy-confirmed"
  | "start-lock"
  | "unlock-cancelled"
  | "unlock-succeeded";

const PHASE_TRANSITIONS: Readonly<
  Record<SessionPhase, Readonly<Partial<Record<SessionTransition, SessionPhase>>>>
> = {
  active: {
    "detach-clean": "released",
    "detach-dirty": "detached-saving",
    "save-confirmed": "active",
    "save-failed": "save-error",
    "start-lock": "locking",
  },
  "detached-saving": {
    "retry-save": "detached-saving",
    "save-confirmed": "released",
    "save-failed": "headless-recovery",
  },
  "headless-recovery": {
    "reload-external": "released",
    "retry-save": "detached-saving",
    "save-local-copy-confirmed": "released",
  },
  "load-error": {
    "detach-clean": "released",
    "dismiss-load-error": "locked",
    "retry-load": "unlocking",
  },
  locked: {},
  locking: {
    "detach-dirty": "detached-saving",
    "save-confirmed": "locked",
    "save-failed": "save-error",
  },
  released: {},
  "save-error": {
    "cancel-recovery": "active",
    "detach-dirty": "headless-recovery",
    "retry-save": "locking",
    "save-local-copy-confirmed": "locked",
  },
  unlocking: {
    "detach-clean": "released",
    "load-failed": "load-error",
    "unlock-cancelled": "locked",
    "unlock-succeeded": "active",
  },
};

export function createUnlockingState(attachment: AttachmentIdentity): SessionState {
  return { attachment, phase: "unlocking" };
}

export function transitionSession(
  state: SessionState,
  transition: SessionTransition,
): SessionState {
  if (transition === "plugin-unload") {
    return { phase: "released" };
  }

  const nextPhase = PHASE_TRANSITIONS[state.phase][transition];
  if (nextPhase === undefined) {
    throw new Error(`Invalid session transition: ${state.phase} -> ${transition}`);
  }

  return isAttachedPhase(nextPhase)
    ? { attachment: requireAttachment(state), phase: nextPhase }
    : { phase: nextPhase };
}

export function replaceSessionAttachment(
  state: SessionState,
  attachment: AttachmentIdentity,
): SessionState {
  if (!isAttachedPhase(state.phase)) {
    throw new Error(`Cannot replace an attachment while session is ${state.phase}`);
  }
  return { attachment, phase: state.phase };
}

export function reattachSession(state: SessionState, attachment: AttachmentIdentity): SessionState {
  if (state.phase === "detached-saving") {
    return { attachment, phase: "active" };
  }
  if (state.phase === "headless-recovery") {
    return { attachment, phase: "save-error" };
  }
  throw new Error(`Cannot reattach a session while it is ${state.phase}`);
}

export function isAttachedSession(
  state: SessionState,
): state is Extract<SessionState, { readonly attachment: AttachmentIdentity }> {
  return "attachment" in state;
}

function isAttachedPhase(phase: SessionPhase): phase is AttachedSessionPhase {
  return (
    phase === "active" ||
    phase === "load-error" ||
    phase === "locking" ||
    phase === "save-error" ||
    phase === "unlocking"
  );
}

function requireAttachment(state: SessionState): AttachmentIdentity {
  if (!isAttachedSession(state)) {
    throw new Error(`Session in ${state.phase} has no presentation attachment`);
  }
  return state.attachment;
}
