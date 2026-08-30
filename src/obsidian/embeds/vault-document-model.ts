import {
  validateRuntimeInkSnapshotV1,
  type InkElementV1,
  type InkSnapshotV1,
} from "../../domain/schema/public";
import type { AutosaveCoordinator } from "../../persistence/saving/autosave/public";
import { createAutosaveSession } from "../../persistence/saving/autosave/session-coordinator";
import type {
  AutosaveSessionBaseOptions,
  ConfirmedPersistence,
} from "../../persistence/saving/autosave/types";
import type { ExistingFilePort } from "../../persistence/saving/save-ports";
import type { DocumentRuntimePort } from "../../persistence/worker/runtime/public";
import type { SessionIdentity } from "../../editor/session/session-port";
import type {
  ElementStore,
  PreparedElementReplacement,
  PreparedElementReplacementResult,
  StoreDelta,
  StoreSliceScheduler,
} from "../../domain/store/public";
import { changedElementDerivations, changedElements } from "./vault-document-model-delta";

import type { EditableDocumentModel } from "./document-model-port";
import { attachEditableDocumentState } from "./editable-document-state";
import { SessionClipboardCoordinator } from "./session-clipboard";
import type { VaultDocumentPersistedEvent } from "./vault-document-recovery";

type EditableActions = Parameters<typeof attachEditableDocumentState>[0];
type EditableState = Parameters<typeof attachEditableDocumentState>[1];

export function createVaultEditableModel(options: {
  readonly actions: Omit<EditableActions, "store">;
  readonly state: EditableState;
  readonly store: ElementStore;
}): EditableDocumentModel {
  return attachEditableDocumentState({ store: options.store, ...options.actions }, options.state);
}

export function createVaultAutosaveSession(
  options: AutosaveSessionBaseOptions & {
    readonly files: ExistingFilePort;
    readonly identity: SessionIdentity;
    readonly page: () => InkSnapshotV1["page"];
    readonly store: ElementStore;
  },
): AutosaveCoordinator {
  return createAutosaveSession({
    ...(options.beforeExistingWrite === undefined
      ? {}
      : { beforeExistingWrite: options.beforeExistingWrite }),
    clock: options.clock,
    confirmed: options.confirmed,
    ...(options.createFallback === undefined ? {} : { createFallback: options.createFallback }),
    currentRevision: options.currentRevision,
    executor: options.executor,
    initialSnapshot: options.initialSnapshot,
    isGestureActive: options.isGestureActive,
    orderByBand: () => ({
      content: options.store.materializeBandOrder("content"),
      highlight: options.store.materializeBandOrder("highlight"),
    }),
    outputHash: options.outputHash,
    path: options.identity.documentId,
    ...(options.requiresCanonicalRewrite === undefined
      ? {}
      : { requiresCanonicalRewrite: options.requiresCanonicalRewrite }),
    sessionId: options.identity.sessionId,
    snapshot: () =>
      options.store.materializeSnapshot({
        page: options.page(),
        revision: options.currentRevision(),
      }),
    vault: options.files,
    workerEpoch: options.workerEpoch,
  });
}

export function createVaultClipboardCoordinator(options: {
  readonly autosave: () => AutosaveCoordinator | undefined;
  readonly disposed: () => boolean;
  readonly executor: () => DocumentRuntimePort | undefined;
  readonly now: () => number;
  readonly revision: () => number;
  readonly sessionId: string;
  readonly workerEpoch: () => number;
}): SessionClipboardCoordinator {
  return new SessionClipboardCoordinator({
    disposed: options.disposed,
    executor: options.executor,
    recoverExecutorFailure: () => options.autosave()?.recoverWorkerExecutor() ?? false,
    synchronizeWorkerBaseline: async (identity) => {
      const autosave = options.autosave();
      return autosave !== undefined && autosave.synchronizeWorkerBaseline(identity);
    },
    now: options.now,
    revision: options.revision,
    sessionId: options.sessionId,
    workerEpoch: options.workerEpoch,
  });
}

export function createConfirmedPersistenceObserver(options: {
  readonly active: () => boolean;
  readonly documentId: string;
  readonly lockedAspectRatio: () => number;
  readonly persisted: ((event: VaultDocumentPersistedEvent) => void) | undefined;
}): (persistence: ConfirmedPersistence) => void {
  return ({ outputHash, revision }) => {
    if (!options.active()) return;
    options.persisted?.({
      documentId: options.documentId,
      lockedAspectRatio: options.lockedAspectRatio(),
      outputHash,
      revision,
    });
  };
}

export function prepareVaultElementReplacement(options: {
  readonly active: boolean;
  readonly cancellation: { isCancelled(): boolean };
  readonly replacements: readonly InkElementV1[];
  readonly scheduler: (isCancelled: () => boolean) => StoreSliceScheduler;
  readonly store: ElementStore | undefined;
}): Promise<PreparedElementReplacementResult> {
  if (options.store === undefined || !options.active) {
    return Promise.resolve({ status: "cancelled", token: null });
  }
  return options.store.prepareElementReplacement(
    options.replacements,
    options.scheduler(() => options.cancellation.isCancelled()),
  );
}

export function commitVaultElementReplacement(options: {
  readonly active: boolean;
  readonly recordDelta: (delta: StoreDelta) => void;
  readonly store: ElementStore | undefined;
  readonly token: PreparedElementReplacement;
}): "cancelled" | "committed" | "noop" {
  if (options.store === undefined || !options.active) return "cancelled";
  const result = options.store.commitPreparedElementReplacement(options.token);
  if (result.delta !== null) options.recordDelta(result.delta);
  return result.status;
}

export function recordVaultStoreDelta(options: {
  readonly autosave: AutosaveCoordinator | undefined;
  readonly delta: StoreDelta;
  readonly removedIds: readonly string[];
  readonly revision: number;
}): void {
  if (options.autosave === undefined) return;
  options.autosave.recordCommit({
    changedElementDerivations: changedElementDerivations(options.delta),
    changedElements: changedElements(options.delta),
    dirtyBands: (Object.keys(options.delta.dirtyBands) as Array<"content" | "highlight">).filter(
      (band) => options.delta.dirtyBands[band],
    ),
    modelRevision: options.revision,
    removedIds: options.removedIds,
  });
}

export function commitVaultPage(options: {
  readonly autosave: AutosaveCoordinator | undefined;
  readonly commit: (state: {
    readonly page: InkSnapshotV1["page"];
    readonly revision: number;
  }) => void;
  readonly page: InkSnapshotV1["page"];
  readonly revision: number;
  readonly store: ElementStore | undefined;
}): void {
  if (options.store === undefined || options.autosave === undefined) return;
  const revision = options.revision + 1;
  const validation = validateRuntimeInkSnapshotV1(
    options.store.materializeSnapshot({ page: options.page, revision }),
  );
  if (!validation.ok) {
    throw new RangeError(
      `Page update is invalid (${validation.error.code} at ${validation.error.path}).`,
    );
  }
  options.commit({ page: validation.value.page, revision });
  options.autosave.recordCommit({ modelRevision: revision, page: validation.value.page });
}

export function requireVaultPage(page: InkSnapshotV1["page"] | undefined): InkSnapshotV1["page"] {
  if (page === undefined) throw new Error("The document page is unavailable.");
  return page;
}
