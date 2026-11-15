import type { InkSnapshotV1, TextElementV2 } from "../../../domain/schema/public";
import type { DocumentRuntimePort } from "../../../persistence/worker/runtime/public";
import { matchesModelSyncResult } from "../../../persistence/saving/autosave/export-request";
import type { SessionOperationIdentity } from "../../../editor/session/session-port";
import type { StoreSliceScheduler } from "../../../domain/store/public";
import type { LoadedVaultDocument } from "./vault-document-loader";
import type { VaultDocumentSessionHooks } from "./vault-document-recovery";

interface NativeTextPreparationOptions {
  readonly cancelled: () => boolean;
  readonly documentId: string;
  readonly executor: DocumentRuntimePort;
  readonly operation: SessionOperationIdentity;
  readonly prepare: NonNullable<VaultDocumentSessionHooks["prepareTextInkBounds"]>;
  readonly purpose: "unlock" | "recovery";
  readonly scheduler: (cancelled: () => boolean) => StoreSliceScheduler;
  readonly workerEpoch: number;
}

/** Original-source trust has completed; derived text metadata stays inside this unpublished load. */
export async function prepareVaultNativeText(
  loaded: LoadedVaultDocument,
  options: NativeTextPreparationOptions,
): Promise<LoadedVaultDocument | undefined> {
  const candidates = loaded.textCandidates;
  if (candidates === undefined || candidates.length === 0) return loaded;
  if (options.cancelled()) return undefined;
  const scheduler = options.scheduler(options.cancelled);
  const byId = new Map<string, (typeof candidates)[number]>();
  const elements: TextElementV2[] = [];
  for (const candidate of candidates) {
    if (options.cancelled()) return undefined;
    byId.set(candidate.element.id, candidate);
    elements.push(candidate.element);
    if (scheduler.shouldYield()) await scheduler.yieldControl();
  }
  const replacements = await runNativePreparation(options, loaded.snapshot, elements);
  if (replacements === undefined) return undefined;
  if (replacements.length === 0) return loaded;
  const changed = new Map<string, TextElementV2>();
  for (const replacement of replacements) {
    const source = byId.get(replacement.id);
    if (source === undefined || changed.has(replacement.id))
      throw new Error("Invalid native text preparation result.");
    changed.set(replacement.id, replacement);
  }
  const prepared = await loaded.store.prepareElementReplacement(replacements, {
    ...scheduler,
    isCancelled: options.cancelled,
    protectLocked: false,
  });
  if (options.cancelled() || prepared.status === "cancelled") return undefined;
  if (prepared.status === "noop") return loaded;
  if (
    prepared.token === null ||
    loaded.store.commitPreparedElementReplacement(prepared.token).status !== "committed"
  )
    throw new Error("Native text preparation could not be adopted.");
  const changedElements = [...changed.keys()].map(
    (id) => loaded.store.get(id)!.element as TextElementV2,
  );
  const request = {
    type: "model-sync-incremental" as const,
    identity: {
      operationId: options.operation.operationId,
      sessionId: options.operation.sessionId,
      workerEpoch: options.workerEpoch,
      purpose: options.purpose,
    },
    baseModelRevision: loaded.snapshot.revision,
    modelRevision: loaded.snapshot.revision,
    changedElements,
  };
  const result = await options.executor.execute(request);
  if (options.cancelled()) return undefined;
  if (!matchesModelSyncResult(request, result))
    throw new Error("Native text metadata synchronization failed.");
  for (const element of changedElements)
    loaded.snapshot.elements[byId.get(element.id)!.index] = element;
  return {
    ...loaded,
    requiresCanonicalRewrite: true,
    snapshot: { ...loaded.snapshot, version: 5 },
  };
}

async function runNativePreparation(
  options: NativeTextPreparationOptions,
  snapshot: InkSnapshotV1,
  elements: readonly TextElementV2[],
): Promise<readonly TextElementV2[] | undefined> {
  let replacements: readonly TextElementV2[];
  try {
    replacements = await options.prepare(options.documentId, snapshot, options.cancelled, elements);
  } catch {
    return undefined;
  }
  return options.cancelled() ? undefined : replacements;
}
