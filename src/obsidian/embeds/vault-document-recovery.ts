import type { FileManager, TFile } from "obsidian";

import { FILE_SCHEMA_LIMITS, type InkSnapshotV1 } from "../../domain/schema/public";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import type {
  RecoveryOperationIdentity,
  RecoveryResult,
  SessionIdentity,
  SessionOperationIdentity,
} from "../../editor/session/session-port";
import type { ExternalChangeOutcome } from "../../persistence/saving/autosave/types";
import type { MetadataGuardedFileRead } from "../../persistence/saving/save-ports";
import type {
  DocumentRuntimePort,
  DocumentRuntimeResult,
} from "../../persistence/worker/runtime/public";
import { adoptOwnedSvgOutput } from "../../persistence/scheduling/owned-svg-output";
import type { TrustedDocumentHeadPort } from "../storage/trusted-document-head-ledger";
import {
  deriveDocumentIntegrityManifest,
  sameDocumentIntegrityManifest,
} from "../../persistence/serialization/public";

export interface RecoveryCompletionOptions {
  readonly replaceMarkdownTarget?: (
    savedPath: string,
    isCurrent: () => boolean,
  ) => boolean | Promise<boolean>;
  readonly reportSavedPath?: (savedPath: string) => void;
}

export interface VaultDocumentPersistedEvent {
  readonly documentId: string;
  readonly lockedAspectRatio: number;
  readonly outputHash: string;
  readonly revision: number;
  readonly readBack?: MetadataGuardedFileRead;
}

export interface VaultDocumentSessionHooks {
  readonly persisted?: (event: VaultDocumentPersistedEvent) => void;
  readonly trustedHeads?: TrustedDocumentHeadPort;
}

export type SessionExternalChangeOutcome = ExternalChangeOutcome | "reloaded" | "reload-failed";

export interface RecoveryFilePort {
  createAndReadBack(
    path: string,
    content: string,
    maximumBytes: number,
  ): Promise<MetadataGuardedFileRead>;
  pathExists(path: string): boolean;
  resolveFile(path: string): TFile;
}

interface SaveRecoveryCopyOptions {
  readonly completion: RecoveryCompletionOptions;
  readonly documentId: string;
  readonly executor: DocumentRuntimePort;
  readonly fileManager: FileManager;
  readonly files: RecoveryFilePort;
  readonly operation: RecoveryOperationIdentity;
  readonly snapshot: InkSnapshotV1;
  readonly workScheduler: WorkScheduler;
  readonly stopped: () => boolean;
  readonly workerEpoch: number;
}

export async function saveSessionRecoveryCopy(
  options: Omit<SaveRecoveryCopyOptions, "executor" | "snapshot"> & {
    readonly executor: DocumentRuntimePort | undefined;
    readonly snapshot: () => InkSnapshotV1 | undefined;
  },
): Promise<RecoveryResult> {
  const snapshot = options.snapshot();
  if (options.executor === undefined || snapshot === undefined || options.stopped()) {
    return failed(options.operation);
  }
  return saveRecoveryCopy({ ...options, executor: options.executor, snapshot });
}

async function discardRecoveryArtifact(
  fileManager: FileManager,
  operation: RecoveryOperationIdentity,
  createdFile?: TFile,
): Promise<RecoveryResult> {
  if (createdFile !== undefined) {
    try {
      await fileManager.trashFile(createdFile);
    } catch {
      // A cleanup failure must not turn an unverified artifact into a confirmed recovery.
    }
  }
  return { ...operation, status: "failed" };
}

function findAvailableRecoveryPath(
  documentId: string,
  pathExists: (path: string) => boolean,
): string {
  const stem = documentId.replace(/\.svg$/iu, "");
  for (let suffix = 1; suffix <= 100; suffix += 1) {
    const path = `${stem}-recovered-${suffix}.svg`;
    if (!pathExists(path)) return path;
  }
  throw new Error("No bounded recovery path is available.");
}

function recoveryVerificationIdentity(operation: RecoveryOperationIdentity, workerEpoch: number) {
  return {
    operationId: operation.operationId,
    purpose: "recovery" as const,
    sessionId: operation.sessionId,
    workerEpoch,
  };
}

export function recoveryHasStopped(
  disposed: boolean,
  current: RecoveryOperationIdentity | undefined,
  operation: RecoveryOperationIdentity,
  revision: number,
  cancelled: ReadonlySet<number>,
): boolean {
  return (
    disposed ||
    current !== operation ||
    revision !== operation.baseRevision ||
    cancelled.has(operation.operationId)
  );
}

export async function saveRecoveryCopy(options: SaveRecoveryCopyOptions): Promise<RecoveryResult> {
  const path = findAvailableRecoveryPath(options.documentId, (candidate) =>
    options.files.pathExists(candidate),
  );
  let createdFile: TFile | undefined;
  try {
    const exported = await exportRecovery(options);
    if (exported === null) return failed(options.operation);
    const trusted = await adoptOwnedSvgOutput(exported.output, exported.outputHash, {
      workScheduler: options.workScheduler,
    });
    if (
      trusted.revision !== exported.modelRevision ||
      trusted.snapshotHash !== exported.integrityManifest.contentDigest
    ) {
      return failed(options.operation);
    }
    const output = trusted.content;
    const readBack = await options.files.createAndReadBack(
      path,
      output,
      FILE_SCHEMA_LIMITS.totalInputBytes,
    );
    createdFile = options.files.resolveFile(path);
    if (options.stopped()) return discard(options, createdFile);
    if (!(await verifyRecovery(options, exported, readBack.content))) {
      return discard(options, createdFile);
    }
    return completeRecovery(options, createdFile);
  } catch {
    createdFile ??= resolveCreatedFile(options.files, path);
    return discard(options, createdFile);
  }
}

async function exportRecovery(
  options: SaveRecoveryCopyOptions,
): Promise<Extract<DocumentRuntimeResult, { type: "export-success" }> | null> {
  const result = await options.executor.execute({
    baseModelRevision: null,
    exportGeneration: 1,
    modelRevision: options.operation.baseRevision,
    sessionId: options.operation.sessionId,
    snapshot: options.snapshot,
    type: "export-full",
    workerEpoch: options.workerEpoch,
  });
  return !options.stopped() &&
    result.type === "export-success" &&
    result.exportGeneration === 1 &&
    result.modelRevision === options.operation.baseRevision &&
    result.sessionId === options.operation.sessionId &&
    result.workerEpoch === options.workerEpoch &&
    sameDocumentIntegrityManifest(
      result.integrityManifest,
      deriveDocumentIntegrityManifest(options.snapshot),
    )
    ? result
    : null;
}

async function verifyRecovery(
  options: SaveRecoveryCopyOptions,
  exported: Extract<DocumentRuntimeResult, { type: "export-success" }>,
  content: string,
): Promise<boolean> {
  const verified = await options.executor.execute({
    identity: recoveryVerificationIdentity(options.operation, options.workerEpoch),
    input: content,
    type: "verify-output",
  });
  return (
    !options.stopped() &&
    verified.type === "verify-output-success" &&
    verified.identity.operationId === options.operation.operationId &&
    verified.identity.sessionId === options.operation.sessionId &&
    verified.identity.workerEpoch === options.workerEpoch &&
    verified.persisted.type === "confirmed" &&
    verified.persisted.outputHash === exported.outputHash &&
    verified.persisted.revision === options.operation.baseRevision
  );
}

async function completeRecovery(
  options: SaveRecoveryCopyOptions,
  createdFile: TFile,
): Promise<RecoveryResult> {
  if (options.stopped()) return discard(options, createdFile);
  const savedPath = createdFile.path;
  options.completion.reportSavedPath?.(savedPath);
  if (options.completion.replaceMarkdownTarget === undefined) {
    return options.stopped()
      ? discard(options, createdFile)
      : { ...options.operation, savedPath, status: "confirmed" };
  }
  let replaced = false;
  try {
    replaced = await options.completion.replaceMarkdownTarget(savedPath, () => !options.stopped());
  } catch {
    // The verified SVG is intentionally preserved when the host Markdown edit fails.
  }
  if (options.stopped()) return discard(options, createdFile);
  return {
    ...options.operation,
    savedPath,
    status: replaced ? "confirmed" : "failed",
  };
}

function resolveCreatedFile(files: RecoveryFilePort, path: string): TFile | undefined {
  try {
    return files.resolveFile(path);
  } catch {
    return undefined;
  }
}

function failed(operation: RecoveryOperationIdentity): RecoveryResult {
  return { ...operation, status: "failed" };
}

function discard(options: SaveRecoveryCopyOptions, file?: TFile): Promise<RecoveryResult> {
  return discardRecoveryArtifact(options.fileManager, options.operation, file);
}

export function acceptsSessionOperation(
  identity: SessionIdentity,
  workerEpoch: number,
  operation: SessionOperationIdentity,
): boolean {
  return (
    operation.documentId === identity.documentId &&
    operation.sessionId === identity.sessionId &&
    operation.workerEpoch === workerEpoch
  );
}

export function acceptsRecoveryOperation(
  identity: SessionIdentity,
  revision: number,
  workerEpoch: number,
  operation: RecoveryOperationIdentity,
): boolean {
  return (
    operation.baseRevision === revision && acceptsSessionOperation(identity, workerEpoch, operation)
  );
}

export async function restoreWorkerBaseline(options: {
  readonly executor: DocumentRuntimePort;
  readonly identity: SessionIdentity;
  readonly revision: number;
  readonly snapshot: InkSnapshotV1;
  readonly workerEpoch: number;
}): Promise<void> {
  try {
    await options.executor.execute({
      baseModelRevision: null,
      exportGeneration: Number.MAX_SAFE_INTEGER,
      modelRevision: options.revision,
      sessionId: options.identity.sessionId,
      snapshot: options.snapshot,
      type: "export-full",
      workerEpoch: options.workerEpoch,
    });
  } catch {
    // The retained dirty model remains authoritative; a later recovery must replace the session.
  }
}

async function loadRecoveryDocument<Value>(options: {
  readonly load: () => Promise<Value | undefined>;
  readonly restore: () => Promise<void>;
  readonly stopped: () => boolean;
}): Promise<Value | undefined> {
  try {
    const loaded = await options.load();
    if (loaded !== undefined && !options.stopped()) return loaded;
  } catch {
    // The current baseline is restored below before recovery reports failure.
  }
  await options.restore();
  return undefined;
}

export async function reloadCleanExternalChange(options: {
  readonly accepts: (operation: SessionOperationIdentity) => boolean;
  readonly baseRevision: () => number;
  readonly notify: () => Promise<ExternalChangeOutcome>;
  readonly operation?: SessionOperationIdentity;
  readonly reload: (operation: RecoveryOperationIdentity) => Promise<RecoveryResult>;
}): Promise<SessionExternalChangeOutcome> {
  const outcome = await options.notify();
  if (outcome !== "reload-required" || options.operation === undefined) return outcome;
  if (!options.accepts(options.operation)) return "reload-failed";
  const result = await options.reload({
    ...options.operation,
    baseRevision: options.baseRevision(),
  });
  return result.status === "confirmed" ? "reloaded" : "reload-failed";
}

export async function reloadExternalDocument<Value>(options: {
  readonly adopt: (loaded: Value) => void;
  readonly load: () => Promise<Value | undefined>;
  readonly releaseAutosave: () => void;
  readonly restore: () => Promise<void>;
  readonly stopped: () => boolean;
}): Promise<boolean> {
  const loaded = await loadRecoveryDocument(options);
  if (loaded === undefined) return false;
  options.releaseAutosave();
  options.adopt(loaded);
  return true;
}
