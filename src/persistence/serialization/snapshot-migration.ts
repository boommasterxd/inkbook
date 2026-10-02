import {
  validateInkSnapshotV1,
  validateInkSnapshotV1Steps,
  validateRuntimeInkSnapshotV1,
  validateRuntimeInkSnapshotV1Steps,
  type SnapshotValidationOptions,
} from "../../domain/schema/snapshot-validation";

const CURRENT_INKBOOK_SNAPSHOT_VERSION = 1;

export interface SnapshotMigrationStep {
  readonly fromVersion: number;
  readonly migrate: (snapshot: unknown) => unknown;
  readonly toVersion: number;
  readonly validate: (snapshot: unknown) => boolean;
  readonly validateSteps?: (snapshot: unknown) => Generator<void, boolean>;
}

export type SnapshotMigrationResult =
  | {
      readonly migrated: boolean;
      readonly ok: true;
      readonly sourceVersion: number;
      readonly value: unknown;
    }
  | {
      readonly code: "invalid-migration" | "invalid-version" | "unsupported-version";
      readonly ok: false;
      readonly sourceVersion?: number;
    };

/** Yields within incremental validation and after every complete migration step. */
export function* migrateSnapshotSequentiallySteps(
  input: unknown,
  migrations: readonly SnapshotMigrationStep[],
  currentVersion = CURRENT_INKBOOK_SNAPSHOT_VERSION,
): Generator<void, SnapshotMigrationResult> {
  if (!isVersion(currentVersion)) return { code: "invalid-version", ok: false };
  const sourceVersion = readInkbookVersion(input);
  if (sourceVersion === null) return { code: "invalid-version", ok: false };
  if (sourceVersion > currentVersion) {
    return { code: "unsupported-version", ok: false, sourceVersion };
  }
  if (sourceVersion === currentVersion) {
    return { migrated: false, ok: true, sourceVersion, value: input };
  }

  const bySource = indexMigrations(migrations, currentVersion);
  if (bySource === null) return { code: "invalid-migration", ok: false, sourceVersion };
  let value = input;
  let version = sourceVersion;
  while (version < currentVersion) {
    const migration = bySource.get(version);
    if (migration === undefined) {
      return { code: "unsupported-version", ok: false, sourceVersion };
    }
    try {
      value = migration.migrate(value);
      const valid =
        migration.validateSteps === undefined
          ? migration.validate(value)
          : yield* migration.validateSteps(value);
      if (readInkbookVersion(value) !== migration.toVersion || !valid) {
        return { code: "invalid-migration", ok: false, sourceVersion };
      }
    } catch {
      return { code: "invalid-migration", ok: false, sourceVersion };
    }
    version = migration.toVersion;
    yield;
  }
  return { migrated: true, ok: true, sourceVersion, value };
}

export function createDocumentSnapshotMigrations(
  options: SnapshotValidationOptions = {},
  allowRuntimeStrokeBuffers = false,
): readonly SnapshotMigrationStep[] {
  return Object.freeze([
    Object.freeze({
      fromVersion: 0,
      migrate: migrateVersionZero,
      toVersion: 1,
      validate: (snapshot: unknown) =>
        (allowRuntimeStrokeBuffers
          ? validateRuntimeInkSnapshotV1(snapshot, options)
          : validateInkSnapshotV1(snapshot, options)
        ).ok,
      validateSteps: function* (snapshot: unknown): Generator<void, boolean> {
        const steps = allowRuntimeStrokeBuffers
          ? validateRuntimeInkSnapshotV1Steps(snapshot, options)
          : validateInkSnapshotV1Steps(snapshot, options);
        return (yield* steps).ok;
      },
    }),
  ]);
}

function indexMigrations(
  migrations: readonly SnapshotMigrationStep[],
  currentVersion: number,
): ReadonlyMap<number, SnapshotMigrationStep> | null {
  const indexed = new Map<number, SnapshotMigrationStep>();
  for (const migration of migrations) {
    if (
      !isVersion(migration.fromVersion) ||
      !isVersion(migration.toVersion) ||
      migration.toVersion !== migration.fromVersion + 1 ||
      migration.toVersion > currentVersion ||
      indexed.has(migration.fromVersion)
    ) {
      return null;
    }
    indexed.set(migration.fromVersion, migration);
  }
  return indexed;
}

function readInkbookVersion(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return record.format === "inkbook" && isVersion(record.version) ? record.version : null;
}

function isVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function migrateVersionZero(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Version 0 snapshot root must be an object.");
  }
  return { ...(value as Record<string, unknown>), version: 1 };
}
