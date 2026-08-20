/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact schema versions exercise upgrade boundaries. */
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";

import {
  DATABASE_SCHEMA_VERSION,
  type IndexedDbRecoveryOptions,
  openIndexedDbRecoveryStore,
} from "../../../src/adapters/recovery-indexed-db";
import { IndexedDbRecoveryStore } from "../../../src/adapters/recovery-indexed-db/store";
import { openRawDatabase, openStore, preparedAttempt } from "./support";

describe("IndexedDB recovery limit configuration", () => {
  it("accepts product maxima and rejects every above-maximum override", async () => {
    const maximumLimits: NonNullable<IndexedDbRecoveryOptions["limits"]> = {
      directSuccessors: 512,
      globalBytes: 32 * 1024 * 1024,
      globalRecords: 16_384,
      noteBytes: 8 * 1024 * 1024,
      noteRecords: 4096,
      queuedBytes: 32 * 1024 * 1024,
      queuedOperations: 64,
    };
    const atMaximum = await openIndexedDbRecoveryStore({
      databaseName: "maximum-limit-overrides",
      indexedDb: new IDBFactory(),
      limits: maximumLimits,
    });
    expect(atMaximum.ok).toBe(true);
    if (atMaximum.ok) await atMaximum.value.dispose();

    const cases: readonly NonNullable<IndexedDbRecoveryOptions["limits"]>[] = [
      { directSuccessors: 513 },
      { globalBytes: 32 * 1024 * 1024 + 1 },
      { globalRecords: 16_385 },
      { noteBytes: 8 * 1024 * 1024 + 1 },
      { noteRecords: 4097 },
      { queuedBytes: 32 * 1024 * 1024 + 1 },
      { queuedOperations: 65 },
    ];
    for (const [index, limits] of cases.entries()) {
      await expect(
        openIndexedDbRecoveryStore({
          databaseName: `above-limit-override-${String(index)}`,
          indexedDb: new IDBFactory(),
          limits,
        }),
      ).resolves.toEqual({ ok: false, code: "recovery-unavailable" });
    }
  });
});

describe("IndexedDB recovery schema", () => {
  it("creates the versioned production stores and required indices", async () => {
    const factory = new IDBFactory();
    const name = "schema-creation";
    const { store } = await openStore(name, {}, factory);
    await store.dispose();

    const database = await openRawDatabase(
      factory,
      name,
      DATABASE_SCHEMA_VERSION,
    );
    expect(Array.from(database.objectStoreNames)).toEqual([
      "accounting",
      "conformance",
      "prefixPlanMembers",
      "records",
    ]);
    const transaction = database.transaction("records", "readonly");
    expect(Array.from(transaction.objectStore("records").indexNames)).toEqual([
      "activePrefixRelocation",
      "baseDigest",
      "basePath",
      "baseRevision",
      "noteKey",
      "noteSessionOrder",
      "prefixScopes",
      "successorKey",
    ]);
    const planTransaction = database.transaction(
      "prefixPlanMembers",
      "readonly",
    );
    expect(
      Array.from(planTransaction.objectStore("prefixPlanMembers").indexNames),
    ).toEqual(["relocationId"]);
    database.close();
  });

  it("replaces the legacy schema without retaining temporary records", async () => {
    const factory = new IDBFactory();
    const name = "schema-upgrade";
    const legacy = await openRawDatabase(factory, name, 2, (database) => {
      database.createObjectStore("legacy-records");
    });
    legacy.close();

    const { store } = await openStore(name, {}, factory);
    await store.dispose();
    const database = await openRawDatabase(
      factory,
      name,
      DATABASE_SCHEMA_VERSION,
    );
    expect(database.objectStoreNames.contains("legacy-records")).toBe(false);
    database.close();
  });

  it("fails closed for unavailable and future-version backends", async () => {
    await expect(
      openIndexedDbRecoveryStore({ indexedDb: undefined }),
    ).resolves.toEqual({
      ok: false,
      code: "recovery-unavailable",
    });
    const factory = new IDBFactory();
    const future = await openRawDatabase(
      factory,
      "future-schema",
      DATABASE_SCHEMA_VERSION + 1,
    );
    future.close();
    await expect(
      openIndexedDbRecoveryStore({
        databaseName: "future-schema",
        indexedDb: factory,
      }),
    ).resolves.toEqual({ ok: false, code: "recovery-unavailable" });
  });
});

describe("IndexedDB recovery lifecycle", () => {
  it("opens the same recovery database concurrently without probe collisions", async () => {
    const factory = new IDBFactory();
    const options = {
      databaseName: "parallel-open",
      indexedDb: factory,
    };

    const [first, second] = await Promise.all([
      openIndexedDbRecoveryStore(options),
      openIndexedDbRecoveryStore(options),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok) await first.value.dispose();
    if (second.ok) await second.value.dispose();
  });

  it("removes its version-change listener exactly once before closing", async () => {
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const addEventListener = vi.fn(
      (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === "versionchange") listeners.add(listener);
      },
    );
    const removeEventListener = vi.fn(
      (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === "versionchange") listeners.delete(listener);
      },
    );
    const close = vi.fn();
    const database = {
      addEventListener,
      close,
      removeEventListener,
    } as unknown as IDBDatabase;
    const store = new IndexedDbRecoveryStore(database, {});

    expect(addEventListener).toHaveBeenCalledOnce();
    await store.dispose();
    await store.dispose();
    expect(removeEventListener).toHaveBeenCalledOnce();
    expect(removeEventListener.mock.calls[0]?.[1]).toBe(
      addEventListener.mock.calls[0]?.[1],
    );
    expect(close).toHaveBeenCalledOnce();

    for (const listener of listeners) {
      if (typeof listener === "function") listener(new Event("versionchange"));
      else listener.handleEvent(new Event("versionchange"));
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it("disposes idempotently and rejects queued or later work", async () => {
    let commits = 0;
    const { store } = await openStore("dispose", {
      faultInjector: {
        beforeCommit: () => {
          commits += 1;
        },
      },
    });
    const queued = store.prepareForward(preparedAttempt());
    const first = store.dispose();
    const second = store.dispose();
    await expect(queued).resolves.toEqual({ ok: false, code: "disposed" });
    await Promise.all([first, second]);
    expect(commits).toBe(0);
    await expect(store.prepareForward(preparedAttempt())).resolves.toEqual({
      ok: false,
      code: "disposed",
    });
  });
});
