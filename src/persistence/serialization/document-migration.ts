import type { InkSnapshotV1, SnapshotValidationDerivations } from "../../domain/schema/public";
import {
  validateInkSnapshotV1,
  validateInkSnapshotV1Steps,
} from "../../domain/schema/snapshot-validation";

import {
  createDocumentSnapshotMigrations,
  migrateSnapshotSequentially,
  migrateSnapshotSequentiallySteps,
} from "./snapshot-migration";
import type { DocumentCodecResult } from "./types";

interface MigrationValidationOptions {
  readonly metadataBytes: number;
  readonly totalInputBytes: number;
}

export interface MigratedSnapshot {
  readonly derivations: SnapshotValidationDerivations;
  readonly snapshot: InkSnapshotV1;
  readonly sourceVersion: number;
}

export function migrateAndValidateDocumentSnapshot(
  value: unknown,
  options: MigrationValidationOptions,
): DocumentCodecResult<MigratedSnapshot> {
  const migrated = migrateSnapshotSequentially(value, createDocumentSnapshotMigrations(options));
  if (!migrated.ok) return migrationFailure();
  const validation = validateInkSnapshotV1(migrated.value, options);
  if (!validation.ok) {
    return {
      error: {
        code: "snapshot-invalid",
        message: "Snapshot validation failed after migration.",
        validationError: validation.error,
      },
      ok: false,
    };
  }
  return {
    ok: true,
    value: {
      derivations: validation.derivations,
      snapshot: validation.value,
      sourceVersion: migrated.sourceVersion,
    },
  };
}

export function* migrateAndValidateDocumentSnapshotSteps(
  value: unknown,
  options: MigrationValidationOptions,
): Generator<void, DocumentCodecResult<MigratedSnapshot>> {
  const migration = migrateSnapshotSequentiallySteps(
    value,
    createDocumentSnapshotMigrations(options),
  );
  let migrationStep = migration.next();
  while (!migrationStep.done) {
    yield;
    migrationStep = migration.next();
  }
  if (!migrationStep.value.ok) return migrationFailure();
  const validation = validateInkSnapshotV1Steps(migrationStep.value.value, options);
  let validationStep = validation.next();
  while (!validationStep.done) {
    yield;
    validationStep = validation.next();
  }
  if (!validationStep.value.ok) {
    return {
      error: {
        code: "snapshot-invalid",
        message: "Snapshot validation failed after migration.",
        validationError: validationStep.value.error,
      },
      ok: false,
    };
  }
  return {
    ok: true,
    value: {
      derivations: validationStep.value.derivations,
      snapshot: validationStep.value.value,
      sourceVersion: migrationStep.value.sourceVersion,
    },
  };
}

function migrationFailure(): DocumentCodecResult<never> {
  return {
    error: { code: "migration-failed", message: "Snapshot migration failed." },
    ok: false,
  };
}
