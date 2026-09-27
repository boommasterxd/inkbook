import { derivePageExtent } from "../../domain/geometry/public";
import {
  validateInkPageV1,
  MAX_DERIVED_HEIGHT,
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
import { preparedPressurePathHint } from "../../persistence/serialization/prepared-pressure-hints";
import type { SessionIdentity } from "../../editor/session/session-port";
import type { InteractiveWorkPriority } from "../../editor/session/interactive-work-priority";
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
    workScheduler: options.workScheduler,
    ...(options.beforeExistingWrite === undefined
      ? {}
      : { beforeExistingWrite: options.beforeExistingWrite }),
    ...(options.waitForBackground === undefined
      ? {}
      : { waitForBackground: options.waitForBackground }),
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
    ownsIntegrityElement: (element) => options.store.get(element.id)?.element === element,
    preparedPressurePaths: (revision, changedIds) =>
      revision === options.currentRevision()
        ? options.store.preparedPressurePaths(changedIds).flatMap(({ record, parts }) => {
            const hint = preparedPressurePathHint(record, parts, revision);
            return hint === undefined ? [] : [hint];
          })
        : [],
    integritySnapshot: () => ({
      format: "inkbook",
      version: 1,
      page: options.page(),
      revision: options.currentRevision(),
      elements: ["highlight", "content"].flatMap((band) =>
        options.store
          .materializeBandOrder(band as "highlight" | "content")
          .map((id) => options.store.get(id)!.element as InkElementV1),
      ),
    }),
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

export function prepareVaultElementMutation(options: {
  readonly active: boolean;
  readonly cancellation: Parameters<EditableDocumentModel["prepareElementMutation"]>[1];
  readonly mutation: Parameters<EditableDocumentModel["prepareElementMutation"]>[0];
  readonly scheduler: (isCancelled: () => boolean) => StoreSliceScheduler;
  readonly store: ElementStore;
}): ReturnType<EditableDocumentModel["prepareElementMutation"]> {
  if (!options.active) return Promise.resolve({ status: "cancelled", token: null });
  return options.store.prepareElementMutation(
    options.mutation,
    options.scheduler(() => options.cancellation.isCancelled()),
    options.cancellation.replay,
  );
}

export async function prepareVaultElementRemoval(options: {
  readonly active: boolean;
  readonly cancellation: Parameters<EditableDocumentModel["prepareElementRemoval"]>[1];
  readonly ids: Parameters<EditableDocumentModel["prepareElementRemoval"]>[0];
  readonly scheduler: (isCancelled: () => boolean) => StoreSliceScheduler;
  readonly store: ElementStore;
}): ReturnType<EditableDocumentModel["prepareElementRemoval"]> {
  if (!options.active) return { status: "cancelled", token: null };
  const scheduler = options.scheduler(() => options.cancellation.isCancelled());
  const mutation = await options.store.createRemovalMutationTimeSliced(options.ids, scheduler);
  if (mutation === "cancelled" || options.cancellation.isCancelled()) {
    return { status: "cancelled", token: null };
  }
  if (mutation === null) return { status: "noop", token: null };
  return options.store.prepareElementMutation(mutation, scheduler);
}

export function createVaultElementPreparationActions(options: {
  readonly active: () => boolean;
  readonly run: InteractiveWorkPriority["run"];
  readonly scheduler: (isCancelled: () => boolean) => StoreSliceScheduler;
  readonly store: ElementStore;
}): Pick<EditableActions, "prepareElementMutation" | "prepareElementRemoval"> {
  return {
    prepareElementMutation: (mutation, cancellation) =>
      options.run(() =>
        prepareVaultElementMutation({
          active: options.active(),
          cancellation,
          mutation,
          scheduler: options.scheduler,
          store: options.store,
        }),
      ),
    prepareElementRemoval: (ids, cancellation) =>
      options.run(() =>
        prepareVaultElementRemoval({
          active: options.active(),
          cancellation,
          ids,
          scheduler: options.scheduler,
          store: options.store,
        }),
      ),
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
  if (!Number.isSafeInteger(revision) || revision < 0) throw new RangeError("Invalid revision.");
  const validation = validateInkPageV1(options.page);
  if (!validation.ok) {
    throw new RangeError(
      `Page update is invalid (${validation.error.code} at ${validation.error.path}).`,
    );
  }
  validatePageExtent(options.store, validation.value);
  const page = { ...validation.value, background: { ...validation.value.background } };
  options.commit({ page, revision });
  options.autosave.recordCommit({ modelRevision: revision, page });
}

export function requireVaultPage(page: InkSnapshotV1["page"] | undefined): InkSnapshotV1["page"] {
  if (page === undefined) throw new Error("The document page is unavailable.");
  return page;
}

function validatePageExtent(store: ElementStore, page: InkSnapshotV1["page"]): void {
  let bottom: number | null = null;
  for (const band of ["highlight", "content"] as const) {
    for (const id of store.materializeBandOrder(band)) {
      const maxY = store.get(id)!.bounds.maxY;
      bottom = bottom === null ? maxY : Math.max(bottom, maxY);
    }
  }
  const extent = derivePageExtent(page, bottom);
  if (extent.activeHeight > MAX_DERIVED_HEIGHT || extent.lockedHeight > MAX_DERIVED_HEIGHT) {
    throw new RangeError("Page update exceeds the maximum derived height.");
  }
}
