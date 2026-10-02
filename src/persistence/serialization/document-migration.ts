import type { InkSnapshotV1, SnapshotValidationDerivations } from "../../domain/schema/public";
import {
  validateInkSnapshotV1Steps,
  validateParsedInkSnapshotV1Steps,
  validateRuntimeInkSnapshotV1Steps,
} from "../../domain/schema/snapshot-validation";
import type { ParsedJsonProof } from "../../domain/schema/parsed-json-proof";

import {
  createDocumentSnapshotMigrations,
  migrateSnapshotSequentiallySteps,
} from "./snapshot-migration";
import type { DocumentCodecResult } from "./types";

interface MigrationValidationOptions {
  readonly metadataBytes: number;
  readonly totalInputBytes: number;
  readonly parsedJsonProof?: ParsedJsonProof;
  readonly allowRuntimeStrokeBuffers?: boolean;
}

export interface MigratedSnapshot {
  readonly derivations: SnapshotValidationDerivations;
  readonly snapshot: InkSnapshotV1;
  readonly sourceVersion: number;
}

export function* migrateAndValidateDocumentSnapshotSteps(
  value: unknown,
  options: MigrationValidationOptions,
): Generator<void, DocumentCodecResult<MigratedSnapshot>> {
  const migration = migrateSnapshotSequentiallySteps(
    value,
    createDocumentSnapshotMigrations(options, options.allowRuntimeStrokeBuffers === true),
  );
  let migrationStep = migration.next();
  while (!migrationStep.done) {
    yield;
    migrationStep = migration.next();
  }
  if (!migrationStep.value.ok) return migrationFailure();
  const validation = createValidationSteps(
    migrationStep.value.value,
    migrationStep.value.migrated,
    options,
  );
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

function createValidationSteps(
  value: unknown,
  migrated: boolean,
  options: MigrationValidationOptions,
) {
  if (options.parsedJsonProof !== undefined && !migrated) {
    return validateParsedInkSnapshotV1Steps(
      value,
      options.parsedJsonProof,
      options,
      options.allowRuntimeStrokeBuffers === true,
    );
  }
  return options.allowRuntimeStrokeBuffers === true
    ? validateRuntimeInkSnapshotV1Steps(value, options)
    : validateInkSnapshotV1Steps(value, options);
}

function migrationFailure(): DocumentCodecResult<never> {
  return {
    error: { code: "migration-failed", message: "Snapshot migration failed." },
    ok: false,
  };
}
