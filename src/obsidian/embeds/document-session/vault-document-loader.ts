import {
  FILE_SCHEMA_LIMITS,
  type InkElementV1,
  type InkSnapshotV1,
} from "../../../domain/schema/public";
import { derivePageExtent } from "../../../domain/geometry/public";
import { ElementStore, type StoreSliceScheduler } from "../../../domain/store/public";
import type { SessionOperationIdentity } from "../../../editor/session/session-port";
import type {
  DocumentRuntimePort,
  UnlockRuntimeBatch,
} from "../../../persistence/worker/runtime/public";
import type { UnlockFile } from "../../vault/file-adapter";
import type { ExistingFilePort, NewFilePort } from "../../../persistence/saving/save-ports";
import type { RecoveryFilePort } from "./vault-document-recovery";
import type { MigrationBackupPort } from "../../../persistence/documents/migration-backup";
import { serializeSvgNumber } from "../../../persistence/documents/svg-number";
import { verifyVaultUnlockIntegrity } from "./vault-unlock-integrity";
import { readVaultPreviewProofCandidate } from "./vault-preview-proof";
import type { SafeStaticProof } from "../../../persistence/serialization/input/safe-static-proof";
import { nextSafeCounter } from "../../../persistence/worker/identity";

export interface VaultExecutorReplacementOutcome {
  readonly executor: DocumentRuntimePort;
  readonly fallbackUsed: boolean;
}

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
    documentId: string,
  ): DocumentRuntimePort;
}

export async function createVaultDocumentExecutor(options: {
  readonly createReplacement?: (epoch: number) => Promise<VaultExecutorReplacementOutcome>;
  readonly disposed: () => boolean;
  readonly documentId: string;
  readonly fallbackUsed: boolean;
  readonly isGestureActive: () => boolean;
  readonly isNavigationActive?: () => boolean;
  readonly runtimes: ExecutorFactoryPort;
  readonly sessionId: string;
  readonly workerEpoch: number;
}): Promise<{
  readonly executor: DocumentRuntimePort;
  readonly fallbackUsed: boolean;
  readonly workerEpoch: number;
}> {
  if (options.disposed()) throw new Error("The document session has been disposed.");
  let candidate: DocumentRuntimePort | undefined;
  try {
    const executor = await options.runtimes.create(
      options.sessionId,
      options.workerEpoch,
      options.documentId,
    );
    candidate = executor;
    if (options.disposed()) {
      throw new Error("The document session has been disposed.");
    }
    initializeExecutorActivity(executor, options);
    return { executor, fallbackUsed: options.fallbackUsed, workerEpoch: options.workerEpoch };
  } catch {
    candidate?.terminate();
    if (options.disposed()) throw new Error("The document session has been disposed.");
    if (options.fallbackUsed) throw new Error("The document fallback executor already failed.");
    const workerEpoch = nextSafeCounter(options.workerEpoch, "workerEpoch");
    if (options.createReplacement !== undefined) {
      const replacement = await options.createReplacement(workerEpoch);
      if (options.disposed()) {
        replacement.executor.terminate();
        throw new Error("The document session has been disposed.");
      }
      return { ...replacement, workerEpoch };
    }
    return {
      executor: createVaultFallbackExecutor({ ...options, workerEpoch }),
      fallbackUsed: true,
      workerEpoch,
    };
  }
}

function createVaultFallbackExecutor(options: {
  readonly documentId: string;
  readonly disposed: () => boolean;
  readonly isGestureActive: () => boolean;
  readonly isNavigationActive?: () => boolean;
  readonly runtimes: ExecutorFactoryPort;
  readonly sessionId: string;
  readonly workerEpoch: number;
}): DocumentRuntimePort {
  if (options.disposed()) throw new Error("The document session has been disposed.");
  const executor = options.runtimes.createFallback(
    options.sessionId,
    options.workerEpoch,
    options.isGestureActive,
    options.documentId,
  );
  try {
    initializeExecutorActivity(executor, options);
    return executor;
  } catch (error) {
    executor.terminate();
    throw error;
  }
}

function initializeExecutorActivity(
  executor: DocumentRuntimePort,
  options: { readonly isGestureActive: () => boolean; readonly isNavigationActive?: () => boolean },
): void {
  if (options.isGestureActive()) executor.setLiveInputActive?.(true);
  if (options.isNavigationActive?.()) executor.setNavigationActive?.(true);
}

export function createVaultFallbackFactory(options: {
  readonly adopt: (executor: DocumentRuntimePort, workerEpoch: number) => void;
  readonly documentId: string;
  readonly disposed: () => boolean;
  readonly isGestureActive: () => boolean;
  readonly isNavigationActive?: () => boolean;
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
  readonly prefetchedBytes?: Promise<Uint8Array | undefined>;
  readonly workerEpoch: number;
  readonly safeStaticProof?: () => SafeStaticProof | undefined;
}

interface RecoveringVaultDocumentLoaderOptions {
  readonly createReplacement?: (epoch: number) => Promise<VaultExecutorReplacementOutcome>;
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
  let executor = options.executor;
  let workerEpoch = options.workerEpoch;
  let fallbackUsed = options.fallbackUsed;
  for (let replacementCount = 0; ; replacementCount += 1) {
    try {
      const loaded = await options.load(executor, workerEpoch);
      return { executor, fallbackUsed, loaded, workerEpoch };
    } catch (error) {
      executor.terminate();
      if (options.cancelled() || fallbackUsed || replacementCount >= 2) throw error;
      workerEpoch = nextSafeCounter(workerEpoch, "workerEpoch");
      const replacement =
        options.createReplacement === undefined
          ? { executor: options.createFallback(workerEpoch), fallbackUsed: true }
          : await options.createReplacement(workerEpoch);
      executor = replacement.executor;
      fallbackUsed = replacement.fallbackUsed;
      if (options.cancelled()) {
        executor.terminate();
        throw error;
      }
    }
  }
}

export async function loadVaultDocument(
  options: VaultDocumentLoaderOptions,
): Promise<LoadedVaultDocument | undefined> {
  const bytes = await (options.prefetchedBytes ??
    readVaultDocumentBytes(options.files, options.documentId));
  if (bytes === undefined || options.cancelled()) return undefined;
  const safeStaticProof =
    options.safeStaticProof === undefined
      ? undefined
      : readVaultPreviewProofCandidate(bytes, options.safeStaticProof);
  if (options.cancelled()) return undefined;
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
        ...(safeStaticProof === undefined ? {} : { safeStaticProof }),
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
    await verifyVaultUnlockIntegrity({
      snapshot,
      store,
      scheduler: options.scheduler(options.cancelled),
    });
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

export async function readVaultDocumentBytes(
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
