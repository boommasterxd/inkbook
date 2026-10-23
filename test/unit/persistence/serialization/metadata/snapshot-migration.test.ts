import { describe, expect, it } from "vitest";

import {
  migrateSnapshotSequentiallySteps,
  type SnapshotMigrationResult,
  type SnapshotMigrationStep,
} from "../../../../../src/persistence/serialization/metadata/snapshot-migration";

function migrateSnapshotSequentiallyForTest(
  input: unknown,
  migrations: readonly SnapshotMigrationStep[],
  currentVersion = 1,
): SnapshotMigrationResult {
  const steps = migrateSnapshotSequentiallySteps(input, migrations, currentVersion);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

describe("snapshot migration sequencing", () => {
  it("runs adjacent pure migrations and verifies every resulting version", () => {
    const result = migrateSnapshotSequentiallyForTest(
      { format: "inkbook", version: 0, value: "old" },
      [
        {
          fromVersion: 0,
          toVersion: 1,
          migrate: (value) => ({ ...(value as object), version: 1 }),
          validate: (value) => (value as { version?: unknown }).version === 1,
        },
        {
          fromVersion: 1,
          toVersion: 2,
          migrate: (value) => ({ ...(value as object), value: "current", version: 2 }),
          validate: (value) => (value as { value?: unknown }).value === "current",
        },
      ],
      2,
    );

    expect(result).toEqual({
      migrated: true,
      ok: true,
      sourceVersion: 0,
      value: { format: "inkbook", value: "current", version: 2 },
    });
  });

  it("rejects gaps, malformed outputs, and newer versions without partial success", () => {
    expect(migrateSnapshotSequentiallyForTest({ format: "inkbook", version: 0 }, [], 1)).toEqual({
      code: "unsupported-version",
      ok: false,
      sourceVersion: 0,
    });
    expect(
      migrateSnapshotSequentiallyForTest(
        { format: "inkbook", version: 0 },
        [
          {
            fromVersion: 0,
            toVersion: 1,
            migrate: () => ({ format: "inkbook", version: 0 }),
            validate: () => true,
          },
        ],
        1,
      ),
    ).toEqual({ code: "invalid-migration", ok: false, sourceVersion: 0 });
    expect(migrateSnapshotSequentiallyForTest({ format: "inkbook", version: 2 }, [], 1)).toEqual({
      code: "unsupported-version",
      ok: false,
      sourceVersion: 2,
    });
  });

  it("rejects an invalid intermediate result before running the next step", () => {
    let secondStepRan = false;
    const result = migrateSnapshotSequentiallyForTest(
      { format: "inkbook", version: 0 },
      [
        {
          fromVersion: 0,
          migrate: (value) => ({ ...(value as object), version: 1 }),
          toVersion: 1,
          validate: () => false,
        },
        {
          fromVersion: 1,
          migrate: (value) => {
            secondStepRan = true;
            return { ...(value as object), version: 2 };
          },
          toVersion: 2,
          validate: () => true,
        },
      ],
      2,
    );

    expect(result).toEqual({ code: "invalid-migration", ok: false, sourceVersion: 0 });
    expect(secondStepRan).toBe(false);
  });
});

describe("snapshot migration slicing", () => {
  it("resumes incremental migration validation without also running its synchronous validator", () => {
    let synchronousValidations = 0;
    let validationSlices = 0;
    const migration = migrateSnapshotSequentiallySteps({ format: "inkbook", version: 0 }, [
      {
        fromVersion: 0,
        migrate: (value) => ({ ...(value as object), version: 1 }),
        toVersion: 1,
        validate: () => {
          synchronousValidations += 1;
          return true;
        },
        validateSteps: function* (): Generator<void, boolean> {
          for (let index = 0; index < 3; index += 1) {
            validationSlices += 1;
            yield;
          }
          return true;
        },
      },
    ]);

    expect(migration.next()).toEqual({ done: false, value: undefined });
    expect(validationSlices).toBe(1);
    expect(migration.next()).toEqual({ done: false, value: undefined });
    expect(migration.next()).toEqual({ done: false, value: undefined });
    expect(migration.next()).toEqual({ done: false, value: undefined });
    expect(migration.next()).toMatchObject({
      done: true,
      value: { migrated: true, ok: true, sourceVersion: 0 },
    });
    expect(validationSlices).toBe(3);
    expect(synchronousValidations).toBe(0);
  });
});
