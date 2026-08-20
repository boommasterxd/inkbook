import {
  commandFailure,
  commandSuccess,
  type CommandResultV1,
  type SettingsRevision,
} from "../../application/note-session";
import {
  confirmStorageMigration,
  createStorageMigrationPreview,
  resumeStorageMigrationFile,
  type FileRelocationPortsV1,
  type StorageMigrationPreviewRequestV1,
  type StorageMigrationPreviewV1,
  type StorageMigrationProgressV1,
  type StorageMigrationV1,
  type SidecarStoragePolicyStoreV1,
} from "../../application/persistence";
import type {
  FileRelocationRecordV1,
  RecoveryStore,
} from "../../application/recovery";
import type {
  OrphanReviewContinuationV1,
  OrphanReviewContinuationResultV1,
  OrphanReviewResult,
} from "./vault-sidecar/events";

interface RuntimeOrphanReviewerV1 {
  continueReview?(
    continuation: OrphanReviewContinuationV1,
    signal?: AbortSignal,
  ): Promise<OrphanReviewContinuationResultV1>;
  review(signal?: AbortSignal): Promise<OrphanReviewResult>;
}

export interface RuntimeMaintenanceControllerConfigV1 {
  readonly orphanReviewer: RuntimeOrphanReviewerV1;
  readonly readSettingsRevision: () => SettingsRevision;
  readonly recovery: RecoveryStore;
  readonly relocationPorts: FileRelocationPortsV1;
}

export function createRuntimeMaintenanceControllerV1(
  recovery: RecoveryStore | null,
  relocationPorts: FileRelocationPortsV1 | null,
  storagePolicy: SidecarStoragePolicyStoreV1,
  orphanReviewer?: RuntimeOrphanReviewerV1,
): RuntimeMaintenanceControllerV1 | null {
  if (
    recovery === null ||
    relocationPorts === null ||
    orphanReviewer === undefined
  )
    return null;
  return new RuntimeMaintenanceControllerV1({
    orphanReviewer,
    readSettingsRevision: () => storagePolicy.snapshot.revision,
    recovery,
    relocationPorts,
  });
}

export class RuntimeMaintenanceControllerV1 {
  readonly #config: RuntimeMaintenanceControllerConfigV1;
  #migration: StorageMigrationV1 | null = null;

  public constructor(config: RuntimeMaintenanceControllerConfigV1) {
    this.#config = config;
  }

  public previewMigration(
    request: StorageMigrationPreviewRequestV1,
  ): CommandResultV1<StorageMigrationPreviewV1> {
    return createStorageMigrationPreview(request);
  }

  public confirmMigration(
    preview: StorageMigrationPreviewV1,
  ): CommandResultV1<StorageMigrationProgressV1> {
    if (preview.collisionCount > 0) {
      return commandFailure("sidecar-conflict");
    }
    if (this.#migration?.progress().state === "progress") {
      return commandFailure("relocation-pending");
    }
    const confirmed = confirmStorageMigration({
      expectedSettingsRevision: this.#config.readSettingsRevision(),
      ports: this.#config.relocationPorts,
      preview,
      recovery: this.#config.recovery,
    });
    if (!confirmed.ok) return confirmed;
    this.#migration = confirmed.value;
    return commandSuccess(confirmed.value.progress());
  }

  public resumeMigration(
    maxFiles: number,
  ): Promise<CommandResultV1<StorageMigrationProgressV1>> {
    return this.#migration === null
      ? Promise.resolve(commandFailure("invalid-command"))
      : this.#migration.runBatch(maxFiles);
  }

  public resumeInterruptedMigration(
    record: FileRelocationRecordV1,
  ): Promise<CommandResultV1<void>> {
    return resumeStorageMigrationFile(
      record,
      this.#config.recovery,
      this.#config.relocationPorts,
    );
  }

  public cancelMigration(): CommandResultV1<StorageMigrationProgressV1> {
    if (this.#migration === null) return commandFailure("invalid-command");
    this.#migration.cancel();
    return commandSuccess(this.#migration.progress());
  }

  public reviewOrphans(signal?: AbortSignal): Promise<OrphanReviewResult> {
    return this.#config.orphanReviewer.review(signal);
  }

  public continueOrphanReview(
    continuation: OrphanReviewContinuationV1,
    signal?: AbortSignal,
  ): Promise<OrphanReviewContinuationResultV1> {
    return (
      this.#config.orphanReviewer.continueReview?.(continuation, signal) ??
      Promise.resolve({ kind: "stale-continuation" })
    );
  }
}
