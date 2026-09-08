import {
  FILE_SCHEMA_LIMITS,
  type InkElementV1,
  type InkSnapshotV1,
} from "../../domain/schema/public";
import { derivePageExtent } from "../../domain/geometry/public";
import { ElementStore, type StoreSliceScheduler } from "../../domain/store/public";
import type { SessionOperationIdentity } from "../../editor/session/session-port";
import type {
  DocumentRuntimePort,
  UnlockRuntimeBatch,
} from "../../persistence/worker/runtime/public";
import type { UnlockFile } from "../vault/file-adapter";
import type { ExistingFilePort, NewFilePort } from "../../persistence/saving/save-ports";
import type { RecoveryFilePort } from "./vault-document-recovery";
import type { MigrationBackupPort } from "../../persistence/documents/migration-backup";
import { serializeSvgNumber } from "../../persistence/documents/svg-number";
import {
  deriveDocumentIntegrityManifest,
  sameDocumentIntegrityManifest,
} from "../../persistence/serialization/public";

interface VaultUnlockFilePort {
  readBinaryForUnlock(path: string, maximumBytes: number): Promise<UnlockFile>;
}

export interface VaultDocumentFilePort
  extends
    VaultUnlockFilePort,
    ExistingFilePort,
    NewFilePort,
    RecoveryFilePort,
    MigrationBackupPort {
  pathExists(path: string): boolean;
  resolveFile(path: string): TFile;
}

interface ExecutorFactoryPort {
  create(sessionId: string, workerEpoch: number, documentId: string): Promise<DocumentRuntimePort>;
  createFallback(
    sessionId: string,
    workerEpoch: number,
    isGestureActive: () => boolean,
  ): DocumentRuntimePort;
}

export async function createVaultDocumentExecutor(options: {
  readonly disposed: () => boolean;
  readonly documentId: string;
  readonly fallbackUsed: boolean;
  readonly isGestureActive: () => boolean;
  readonly runtimes: ExecutorFactoryPort;
  readonly sessionId: string;
  readonly workerEpoch: number;
}): Promise<{
  readonly executor: DocumentRuntimePort;
  readonly fallbackUsed: boolean;
  readonly workerEpoch: number;
}> {
  if (options.disposed()) throw new Error("The document session has been disposed.");
  try {
    const executor = await options.runtimes.create(
      options.sessionId,
      options.workerEpoch,
      options.documentId,
    );
    if (options.disposed()) {
      executor.terminate();
      throw new Error("The document session has been disposed.");
    }
    return { executor, fallbackUsed: options.fallbackUsed, workerEpoch: options.workerEpoch };
  } catch {
    if (options.disposed()) throw new Error("The document session has been disposed.");
    if (options.fallbackUsed) throw new Error("The document fallback executor already failed.");
    const workerEpoch = options.workerEpoch + 1;
    return {
      executor: options.runtimes.createFallback(
        options.sessionId,
        workerEpoch,
        options.isGestureActive,
      ),
      fallbackUsed: true,
      workerEpoch,
    };
  }
}

function createVaultFallbackExecutor(options: {
  readonly disposed: () => boolean;
  readonly isGestureActive: () => boolean;
  readonly runtimes: ExecutorFactoryPort;
  readonly sessionId: string;
  readonly workerEpoch: number;
}): DocumentRuntimePort {
  if (options.disposed()) throw new Error("The document session has been disposed.");
  return options.runtimes.createFallback(
    options.sessionId,
    options.workerEpoch,
    options.isGestureActive,
  );
}

export function createVaultFallbackFactory(options: {
  readonly adopt: (executor: DocumentRuntimePort, workerEpoch: number) => void;
  readonly disposed: () => boolean;
  readonly isGestureActive: () => boolean;
  readonly runtimes: ExecutorFactoryPort;
  readonly sessionId: string;
}): (workerEpoch: number) => DocumentRuntimePort {
  return (workerEpoch) => {
    const executor = createVaultFallbackExecutor({ ...options, workerEpoch });
    options.adopt(executor, workerEpoch);
    return executor;
  };
}

export interface LoadedVaultDocument {
  readonly outputHash: string;
  readonly requiresCanonicalRewrite: boolean;
  readonly snapshot: InkSnapshotV1;
  readonly sourceVersion: number;
  readonly store: ElementStore;
}

interface VaultDocumentLoaderOptions {
  readonly cancelled: () => boolean;
  readonly documentId: string;
  readonly executor: DocumentRuntimePort;
  readonly operation: SessionOperationIdentity;
  readonly purpose: "recovery" | "unlock";
  readonly scheduler: (isCancelled: () => boolean) => StoreSliceScheduler;
  readonly files: VaultUnlockFilePort;
  readonly workerEpoch: number;
}

interface RecoveringVaultDocumentLoaderOptions {
  readonly cancelled: () => boolean;
  readonly createFallback: (workerEpoch: number) => DocumentRuntimePort;
  readonly executor: DocumentRuntimePort;
  readonly fallbackUsed: boolean;
  readonly load: (
    executor: DocumentRuntimePort,
    workerEpoch: number,
  ) => Promise<LoadedVaultDocument | undefined>;
  readonly workerEpoch: number;
}

export async function loadVaultDocumentWithExecutorRecovery(
  options: RecoveringVaultDocumentLoaderOptions,
): Promise<{
  readonly executor: DocumentRuntimePort;
  readonly fallbackUsed: boolean;
  readonly loaded: LoadedVaultDocument | undefined;
  readonly workerEpoch: number;
}> {
  try {
    const loaded = await options.load(options.executor, options.workerEpoch);
    return {
      executor: options.executor,
      fallbackUsed: options.fallbackUsed,
      loaded,
      workerEpoch: options.workerEpoch,
    };
  } catch (error) {
    options.executor.terminate();
    if (options.cancelled() || options.fallbackUsed) throw error;
    const workerEpoch = options.workerEpoch + 1;
    const executor = options.createFallback(workerEpoch);
    const loaded = await options.load(executor, workerEpoch);
    return { executor, fallbackUsed: true, loaded, workerEpoch };
  }
}

export async function loadVaultDocument(
  options: VaultDocumentLoaderOptions,
): Promise<LoadedVaultDocument | undefined> {
  const bytes = await readVaultBytes(options.files, options.documentId);
  if (bytes === undefined || options.cancelled()) return undefined;
  const elements: InkElementV1[] = [];
  const builder = ElementStore.createBuilder(options.scheduler(options.cancelled));
  let nextBatchIndex = 0;
  try {
    const result = await options.executor.execute(
      {
        identity: {
          operationId: options.operation.operationId,
          purpose: options.purpose,
          sessionId: options.operation.sessionId,
          workerEpoch: options.workerEpoch,
        },
        input: bytes,
        type: "unlock",
      },
      {
        unlockBatch: async (batch, signal) => {
          signal.throwIfAborted();
          acceptBatch(batch, options.operation, options.workerEpoch, nextBatchIndex);
          if (
            (await builder.appendOwnedValidatedRuntime(batch.elements, batch.derivations)) ===
            "cancelled"
          ) {
            throw new Error("The incremental store adoption was cancelled.");
          }
          nextBatchIndex += 1;
          elements.push(...batch.elements);
        },
      },
    );
    if (
      options.cancelled() ||
      result.type !== "unlock-success" ||
      !matchesUnlockIdentity(result, options) ||
      result.snapshot.batchCount !== nextBatchIndex ||
      result.snapshot.elementCount !== elements.length
    ) {
      builder.cancel();
      return undefined;
    }
    const store = await builder.finalize();
    if (store === null || options.cancelled()) return undefined;
    const snapshot: InkSnapshotV1 = {
      elements,
      format: result.snapshot.format,
      page: result.snapshot.page,
      revision: result.snapshot.revision,
      version: result.snapshot.version,
    };
    const receivedManifest = deriveDocumentIntegrityManifest(snapshot);
    const storeManifest = deriveDocumentIntegrityManifest(
      store.materializeSnapshot({ page: snapshot.page, revision: snapshot.revision }),
    );
    if (
      !sameDocumentIntegrityManifest(result.integrityManifest, receivedManifest) ||
      !sameDocumentIntegrityManifest(receivedManifest, storeManifest)
    ) {
      throw new Error("The unlock snapshot, batches, and finalized store diverged.");
    }
    return {
      outputHash: result.outputHash,
      requiresCanonicalRewrite:
        result.requiresCanonicalRewrite ||
        result.lockedHeight !==
          Number(
            serializeSvgNumber(
              derivePageExtent(snapshot.page, store.getMaximumBottom() ?? null).lockedHeight,
            ),
          ),
      snapshot,
      sourceVersion: result.sourceVersion,
      store,
    };
  } catch (error) {
    builder.cancel();
    throw error;
  }
}

function matchesUnlockIdentity(
  result: Extract<Awaited<ReturnType<DocumentRuntimePort["execute"]>>, { type: "unlock-success" }>,
  options: VaultDocumentLoaderOptions,
): boolean {
  return (
    result.identity.operationId === options.operation.operationId &&
    result.identity.purpose === options.purpose &&
    result.identity.sessionId === options.operation.sessionId &&
    result.identity.workerEpoch === options.workerEpoch
  );
}

async function readVaultBytes(
  files: VaultUnlockFilePort,
  documentId: string,
): Promise<Uint8Array | undefined> {
  try {
    const read = await files.readBinaryForUnlock(documentId, FILE_SCHEMA_LIMITS.totalInputBytes);
    return new Uint8Array(read.bytes);
  } catch {
    return undefined;
  }
}

function acceptBatch(
  batch: UnlockRuntimeBatch,
  operation: SessionOperationIdentity,
  workerEpoch: number,
  expectedBatchIndex: number,
): void {
  if (
    batch.batchIndex !== expectedBatchIndex ||
    batch.identity.operationId !== operation.operationId ||
    batch.identity.sessionId !== operation.sessionId ||
    batch.identity.workerEpoch !== workerEpoch
  ) {
    throw new Error("The unlock batch identity is stale or out of order.");
  }
}
import type { TFile } from "obsidian";
