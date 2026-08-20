import { commandFailure, commandSuccess } from "../note-session/results";
import type { CommandResultV1, SettingsRevision } from "../note-session/types";
import {
  isNormalizedVaultPath,
  isNormalizedVaultPrefix,
  validateRelocationStart,
  type FileRelocationRecordV1,
  type RecoveryStore,
} from "../recovery";
import {
  beginFileRelocation,
  resumeFileRelocation,
  type FileRelocationPortsV1,
} from "./relocation";

export const STORAGE_MIGRATION_LIMITS_V1 = Object.freeze({
  maxCandidates: 10_000,
  maxFilesPerBatch: 512,
});

export type StorageMigrationCandidateV1 =
  | {
      readonly kind: "ready";
      readonly record: FileRelocationRecordV1;
    }
  | {
      readonly kind: "collision";
      readonly sourceSidecarPath: string;
      readonly destinationSidecarPath: string;
    }
  | {
      readonly kind: "unsupported";
      readonly sourceSidecarPath: string;
    };

export interface StorageMigrationPreviewRequestV1 {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly settingsRevision: SettingsRevision;
  readonly candidates: readonly StorageMigrationCandidateV1[];
  readonly continuationRequired: boolean;
}

export interface StorageMigrationPreviewV1 {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly settingsRevision: SettingsRevision;
  readonly candidateCount: number;
  readonly readyCount: number;
  readonly collisionCount: number;
  readonly unsupportedCount: number;
  readonly estimatedFileOperations: number;
  readonly continuationRequired: boolean;
  readonly readyRecords: readonly FileRelocationRecordV1[];
}

export interface ConfirmStorageMigrationRequestV1 {
  readonly preview: StorageMigrationPreviewV1;
  readonly expectedSettingsRevision: SettingsRevision;
  readonly recovery: RecoveryStore;
  readonly ports: FileRelocationPortsV1;
}

export interface StorageMigrationProgressV1 {
  readonly state: "progress" | "cancelled" | "complete";
  readonly migratedFiles: number;
  readonly remainingFiles: number;
}

export function createStorageMigrationPreview(
  request: StorageMigrationPreviewRequestV1,
): CommandResultV1<StorageMigrationPreviewV1> {
  if (!validPreviewRequest(request)) return commandFailure("invalid-command");
  const readyRecords = request.candidates.flatMap((candidate) =>
    candidate.kind === "ready" ? [candidate.record] : [],
  );
  return commandSuccess(
    Object.freeze({
      candidateCount: request.candidates.length,
      collisionCount: countKind(request.candidates, "collision"),
      continuationRequired: request.continuationRequired,
      destinationRoot: request.destinationRoot,
      estimatedFileOperations: readyRecords.length,
      readyCount: readyRecords.length,
      readyRecords: Object.freeze(readyRecords),
      settingsRevision: request.settingsRevision,
      sourceRoot: request.sourceRoot,
      unsupportedCount: countKind(request.candidates, "unsupported"),
    }),
  );
}

export function confirmStorageMigration(
  request: ConfirmStorageMigrationRequestV1,
): CommandResultV1<StorageMigrationV1> {
  return StorageMigrationV1.confirm(request);
}

export async function resumeStorageMigrationFile(
  record: FileRelocationRecordV1,
  recovery: RecoveryStore,
  ports: FileRelocationPortsV1,
): Promise<CommandResultV1<void>> {
  if (record.kind !== "sidecar-location") {
    return commandFailure("invalid-command");
  }
  return resumeFileRelocation(record, recovery, ports);
}

export class StorageMigrationV1 {
  readonly #records: readonly FileRelocationRecordV1[];
  readonly #recovery: RecoveryStore;
  readonly #ports: FileRelocationPortsV1;
  #cursor = 0;
  #cancelRequested = false;
  #running = false;

  private constructor(request: ConfirmStorageMigrationRequestV1) {
    this.#records = request.preview.readyRecords;
    this.#recovery = request.recovery;
    this.#ports = request.ports;
  }

  public static confirm(
    request: ConfirmStorageMigrationRequestV1,
  ): CommandResultV1<StorageMigrationV1> {
    if (!validConfirmedPreview(request.preview)) {
      return commandFailure("invalid-command");
    }
    if (
      request.preview.settingsRevision !== request.expectedSettingsRevision ||
      request.preview.readyRecords.some(
        (record) =>
          record.expectedSettingsRevision !== request.expectedSettingsRevision,
      )
    ) {
      return commandFailure("stale-source");
    }
    return commandSuccess(new StorageMigrationV1(request));
  }

  public cancel(): void {
    this.#cancelRequested = true;
  }

  public progress(): StorageMigrationProgressV1 {
    const current = this.currentState();
    const state =
      current === "complete" || !this.#cancelRequested ? current : "cancelled";
    return progress(state, this.#cursor, this.#records.length);
  }

  public async runBatch(
    maxFiles: number,
  ): Promise<CommandResultV1<StorageMigrationProgressV1>> {
    if (!validBatchSize(maxFiles) || this.#running) {
      return commandFailure("invalid-command");
    }
    this.#running = true;
    try {
      return await this.runBoundedBatch(maxFiles);
    } finally {
      this.#running = false;
    }
  }

  async runBoundedBatch(
    maxFiles: number,
  ): Promise<CommandResultV1<StorageMigrationProgressV1>> {
    const stop = Math.min(this.#cursor + maxFiles, this.#records.length);
    while (this.#cursor < stop && !this.#cancelRequested) {
      const record = this.#records[this.#cursor];
      if (record === undefined) return commandFailure("invalid-command");
      const migrated = await beginFileRelocation(
        record,
        this.#recovery,
        this.#ports,
      );
      if (!migrated.ok) return migrated;
      this.#cursor += 1;
    }
    return commandSuccess(this.progress());
  }

  currentState(): StorageMigrationProgressV1["state"] {
    return this.#cursor === this.#records.length ? "complete" : "progress";
  }
}

function validConfirmedPreview(preview: StorageMigrationPreviewV1): boolean {
  const counts = [
    preview.candidateCount,
    preview.readyCount,
    preview.collisionCount,
    preview.unsupportedCount,
    preview.estimatedFileOperations,
  ];
  return (
    isNormalizedVaultPrefix(preview.sourceRoot) &&
    isNormalizedVaultPrefix(preview.destinationRoot) &&
    preview.sourceRoot !== preview.destinationRoot &&
    counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    preview.candidateCount <= STORAGE_MIGRATION_LIMITS_V1.maxCandidates &&
    preview.readyCount === preview.readyRecords.length &&
    preview.estimatedFileOperations === preview.readyRecords.length &&
    preview.candidateCount ===
      preview.readyCount + preview.collisionCount + preview.unsupportedCount &&
    preview.readyRecords.every((record) =>
      validCandidate({ kind: "ready", record }, preview.settingsRevision),
    )
  );
}

function validPreviewRequest(
  request: StorageMigrationPreviewRequestV1,
): boolean {
  return (
    isNormalizedVaultPrefix(request.sourceRoot) &&
    isNormalizedVaultPrefix(request.destinationRoot) &&
    request.sourceRoot !== request.destinationRoot &&
    Number.isSafeInteger(request.settingsRevision) &&
    request.settingsRevision > 0 &&
    request.candidates.length <= STORAGE_MIGRATION_LIMITS_V1.maxCandidates &&
    request.candidates.every((candidate) =>
      validCandidate(candidate, request.settingsRevision),
    )
  );
}

function validCandidate(
  candidate: StorageMigrationCandidateV1,
  settingsRevision: SettingsRevision,
): boolean {
  if (candidate.kind === "ready") {
    const record = candidate.record;
    return (
      record.kind === "sidecar-location" &&
      record.step === "prepared" &&
      record.expectedSettingsRevision === settingsRevision &&
      record.sourceMarkdownPath === record.destinationMarkdownPath &&
      validateRelocationStart(record).ok
    );
  }
  return (
    isNormalizedVaultPath(candidate.sourceSidecarPath) &&
    (candidate.kind === "unsupported" ||
      isNormalizedVaultPath(candidate.destinationSidecarPath))
  );
}

function countKind(
  candidates: readonly StorageMigrationCandidateV1[],
  kind: "collision" | "unsupported",
): number {
  return candidates.reduce(
    (count, candidate) => count + (candidate.kind === kind ? 1 : 0),
    0,
  );
}

function validBatchSize(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= STORAGE_MIGRATION_LIMITS_V1.maxFilesPerBatch
  );
}

function progress(
  state: StorageMigrationProgressV1["state"],
  migratedFiles: number,
  totalFiles: number,
): StorageMigrationProgressV1 {
  return Object.freeze({
    migratedFiles,
    remainingFiles: totalFiles - migratedFiles,
    state,
  });
}
