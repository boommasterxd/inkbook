import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { DATABASE_SCHEMA_VERSION } from "../../../src/adapters/recovery-indexed-db";
import {
  expectReady,
  openRawDatabase,
  probeRecovery,
  requestValue,
} from "./support";

describe("IndexedDB recovery conformance probe", () => {
  it("creates the versioned schema and removes its transaction probe exactly", async () => {
    const factory = new IDBFactory();
    const name = "schema-creation";
    const store = expectReady(
      await probeRecovery({ indexedDb: factory, databaseName: name }),
    );
    await store.dispose();

    const database = await openRawDatabase(
      factory,
      name,
      DATABASE_SCHEMA_VERSION,
    );
    expect(database.version).toBe(DATABASE_SCHEMA_VERSION);
    expect(Array.from(database.objectStoreNames)).toEqual([
      "accounting",
      "attempts",
      "probe",
    ]);
    const transaction = database.transaction("probe", "readonly");
    await expect(
      requestValue(transaction.objectStore("probe").getAll()),
    ).resolves.toEqual([]);
    database.close();
  });

  it("upgrades a compatible version-one schema", async () => {
    const factory = new IDBFactory();
    const name = "schema-upgrade";
    const legacy = await openRawDatabase(factory, name, 1, (database): void => {
      const attempts = database.createObjectStore("attempts", {
        keyPath: "key",
      });
      attempts.createIndex("noteKey", "noteKey");
      database.createObjectStore("probe");
    });
    legacy.close();

    const store = expectReady(
      await probeRecovery({ indexedDb: factory, databaseName: name }),
    );
    await store.dispose();
    const upgraded = await openRawDatabase(
      factory,
      name,
      DATABASE_SCHEMA_VERSION,
    );
    expect(upgraded.objectStoreNames.contains("accounting")).toBe(true);
    upgraded.close();
  });

  it("returns truthful read-only results for unavailable and future schemas", async () => {
    await expect(probeRecovery({ indexedDb: undefined })).resolves.toEqual({
      kind: "read-only",
      reason: "backend-unavailable",
    });

    const factory = new IDBFactory();
    const future = await openRawDatabase(
      factory,
      "future-schema",
      DATABASE_SCHEMA_VERSION + 1,
    );
    future.close();
    await expect(
      probeRecovery({
        indexedDb: factory,
        databaseName: "future-schema",
      }),
    ).resolves.toEqual({ kind: "read-only", reason: "schema-incompatible" });
  });
});
