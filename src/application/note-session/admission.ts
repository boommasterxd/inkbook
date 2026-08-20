import { validateNoteAppearanceV1 } from "../../domain/codecs/scene-validation";
import { commandFailure, commandSuccess } from "./results";
import type {
  AnnotationCommandRequestV1,
  CommandAdmissionTokenV1,
  CommandErrorCodeV1,
  CommandResultV1,
  CommandRevalidationContextV1,
  CommandViewV1,
  EffectiveViewAccessV1,
  FirstSidecarPendingV1,
  HistoryEpoch,
  NoteSessionSnapshotV1,
} from "./types";

export function deriveEffectiveViewAccess(
  snapshot: NoteSessionSnapshotV1,
  view: CommandViewV1,
): EffectiveViewAccessV1 {
  if (view.mode === "reading") {
    return Object.freeze({ kind: "reading-read-only" });
  }
  if (!view.historyAvailable) {
    return Object.freeze({
      kind: "blocked",
      reason: "history-unavailable",
    });
  }

  const lease = snapshot.historyLease;
  if (lease.kind === "blocked") {
    return Object.freeze({ kind: "blocked", reason: lease.reason });
  }
  if (lease.kind === "closing") {
    return Object.freeze({
      kind: "blocked",
      reason: "history-lease-unavailable",
    });
  }
  if (lease.kind === "owned") {
    return lease.ownerViewId === view.viewId
      ? Object.freeze({ epoch: lease.epoch, kind: "mutable" })
      : Object.freeze({
          kind: "secondary-read-only",
          ownerViewId: lease.ownerViewId,
        });
  }
  return view.prospectiveHistoryEpoch === null
    ? Object.freeze({
        kind: "blocked",
        reason: "history-lease-unavailable",
      })
    : Object.freeze({
        epoch: view.prospectiveHistoryEpoch,
        kind: "mutable",
      });
}

export function admitCommand(
  snapshot: NoteSessionSnapshotV1,
  view: CommandViewV1,
  request: AnnotationCommandRequestV1,
): CommandResultV1<CommandAdmissionTokenV1> {
  const failure = validateAvailability(snapshot, view, request);
  if (failure !== null) return commandFailure(failure);

  const access = deriveEffectiveViewAccess(snapshot, view);
  if (access.kind !== "mutable") {
    return commandFailure(accessFailure(access));
  }
  return commandSuccess(freezeAdmissionToken(request, view, access.epoch));
}

export function revalidateCommandAdmission(
  snapshot: NoteSessionSnapshotV1,
  view: CommandViewV1,
  token: CommandAdmissionTokenV1,
  context: CommandRevalidationContextV1,
): CommandResultV1<CommandAdmissionTokenV1> {
  if (token.viewId !== view.viewId) return commandFailure("invalid-command");
  const request: AnnotationCommandRequestV1 = {
    expectedLayoutRevision: token.layoutRevision,
    expectedSceneRevision: token.sceneRevision,
    expectedSourceDigest: token.sourceDigest,
    expectedSourceGeneration: token.sourceGeneration,
    historyEntryId: token.historyEntryId,
    firstSidecarExpectation: token.firstSidecarExpectation,
    operationId: token.operationId,
    recoveryAttemptId: token.recoveryAttemptId,
    recoveryAvailable: context.recoveryAvailable,
  };
  const result = admitCommand(snapshot, view, request);
  if (!result.ok) return result;
  return result.value.historyEpoch === token.historyEpoch
    ? commandSuccess(token)
    : commandFailure("history-lease-unavailable");
}

function validateAvailability(
  snapshot: NoteSessionSnapshotV1,
  view: CommandViewV1,
  request: AnnotationCommandRequestV1,
): CommandErrorCodeV1 | null {
  if (snapshot.lifecycle === "disposed") return "disposed";
  if (snapshot.lifecycle !== "ready") return "read-only-mode";
  if (!request.recoveryAvailable) return "recovery-unavailable";
  const persistenceFailure = persistenceError(snapshot, request);
  if (persistenceFailure !== null) return persistenceFailure;
  if (snapshot.source.kind !== "durable") return "stale-source";
  if (
    snapshot.source.generation !== request.expectedSourceGeneration ||
    snapshot.source.digest !== request.expectedSourceDigest
  ) {
    return "stale-source";
  }
  if (snapshot.scene.revision !== request.expectedSceneRevision) {
    return "stale-scene";
  }
  if (view.layoutRevision !== request.expectedLayoutRevision) {
    return "stale-layout";
  }
  return null;
}

function persistenceError(
  snapshot: NoteSessionSnapshotV1,
  request: AnnotationCommandRequestV1,
): CommandErrorCodeV1 | null {
  const persistence = snapshot.persistence;
  switch (persistence.kind) {
    case "conflict":
      return "sidecar-conflict";
    case "drift":
      return "sidecar-drift";
    case "relocating":
      return "relocation-pending";
    case "newer-version":
      return "read-only-mode";
    case "first-sidecar-pending":
      return pendingMatches(persistence.pending, request)
        ? null
        : "invalid-command";
    case "clean":
    case "dirty":
    case "saving":
      return request.firstSidecarExpectation === null
        ? null
        : "invalid-command";
    case "unannotated":
      return request.firstSidecarExpectation === null ||
        !isEmptyUnannotatedScene(snapshot)
        ? "invalid-command"
        : null;
  }
}

function isEmptyUnannotatedScene(snapshot: NoteSessionSnapshotV1): boolean {
  const { scene } = snapshot;
  const empty =
    scene.revision === 0 &&
    scene.elementsById.size === 0 &&
    scene.objectOrder.length === 0 &&
    scene.groupsById.size === 0;
  if (!empty) return false;
  try {
    validateNoteAppearanceV1(scene.noteAppearance);
    return true;
  } catch {
    return false;
  }
}

function pendingMatches(
  pending: FirstSidecarPendingV1,
  request: AnnotationCommandRequestV1,
): boolean {
  return (
    request.firstSidecarExpectation !== null &&
    pending.operationId === request.operationId &&
    pending.historyEntryId === request.historyEntryId &&
    pending.recoveryAttemptId === request.recoveryAttemptId &&
    pending.expectedSourceGeneration === request.expectedSourceGeneration &&
    pending.expectedSourceDigest === request.expectedSourceDigest &&
    pending.expectedVaultRelativePath ===
      request.firstSidecarExpectation.expectedVaultRelativePath &&
    pending.expectedSettingsRevision ===
      request.firstSidecarExpectation.expectedSettingsRevision &&
    pending.noteIdentity.vaultIdHint ===
      request.firstSidecarExpectation.noteIdentity.vaultIdHint &&
    pending.noteIdentity.vaultRelativeMarkdownPath ===
      request.firstSidecarExpectation.noteIdentity.vaultRelativeMarkdownPath
  );
}

function accessFailure(
  access: Exclude<EffectiveViewAccessV1, { readonly kind: "mutable" }>,
): CommandErrorCodeV1 {
  if (access.kind === "blocked") return access.reason;
  return access.kind === "reading-read-only"
    ? "read-only-mode"
    : "history-lease-unavailable";
}

function freezeAdmissionToken(
  request: AnnotationCommandRequestV1,
  view: CommandViewV1,
  historyEpoch: HistoryEpoch,
): CommandAdmissionTokenV1 {
  return Object.freeze({
    historyEntryId: request.historyEntryId,
    historyEpoch,
    layoutRevision: request.expectedLayoutRevision,
    firstSidecarExpectation:
      request.firstSidecarExpectation === null
        ? null
        : Object.freeze({
            ...request.firstSidecarExpectation,
            noteIdentity: Object.freeze({
              ...request.firstSidecarExpectation.noteIdentity,
            }),
          }),
    operationId: request.operationId,
    recoveryAttemptId: request.recoveryAttemptId,
    sceneRevision: request.expectedSceneRevision,
    sourceDigest: request.expectedSourceDigest,
    sourceGeneration: request.expectedSourceGeneration,
    viewId: view.viewId,
  });
}
