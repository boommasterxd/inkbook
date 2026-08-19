import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { DATABASE_SCHEMA_VERSION } from "../../../src/adapters/recovery-indexed-db";
import {
  corruptFirstAttempt,
  expectReady,
  loadAndRelease,
  NOTE,
  openRawDatabase,
  preparedRecord,
  probeRecovery,
} from "./support";

describe("IndexedDB recovery failures", () => {
  it("rolls back an explicitly aborted transaction without accounting drift", async () => {
    let abortNext = true;
    const store = expectReady(
      await probeRecovery({
        indexedDb: new IDBFactory(),
        databaseName: "transaction-abort",
        faultInjector: {
          beforeCommit: (_operation, transaction) => {
            if (abortNext) {
              abortNext = false;
              transaction.abort();
            }
          },
        },
      }),
    );
    await expect(store.prepareForward(preparedRecord())).resolves.toEqual({
      kind: "transaction-aborted",
    });
    await expect(loadAndRelease(store, NOTE)).resolves.toEqual({
      kind: "loaded",
      records: [],
    });
    await expect(store.getByteUsage(NOTE)).resolves.toEqual({
      globalBytes: 0,
      noteBytes: 0,
    });
    await expect(store.prepareForward(preparedRecord())).resolves.toMatchObject(
      {
        kind: "written",
      },
    );
    await store.dispose();
  });

  it("maps storage quota errors and preserves the prior durable record", async () => {
    let exhaustQuota = false;
    const store = expectReady(
      await probeRecovery({
        indexedDb: new IDBFactory(),
        databaseName: "backend-quota",
        faultInjector: {
          beforeCommit: () => {
            if (exhaustQuota) {
              throw new DOMException("Fixture quota", "QuotaExceededError");
            }
          },
        },
      }),
    );
    const first = await store.prepareForward(preparedRecord());
    expect(first).toMatchObject({ kind: "written" });
    exhaustQuota = true;
    await expect(
      store.prepareForward(preparedRecord("attempt-2", 1 + 1)),
    ).resolves.toEqual({ kind: "quota-exceeded" });
    await expect(loadAndRelease(store, NOTE)).resolves.toMatchObject({
      kind: "loaded",
      records: [{ attemptId: "attempt-1" }],
    });
    await store.dispose();
  });

  it("enforces the exact per-note byte boundary before commit", async () => {
    const record = preparedRecord();
    const exactBytes = new TextEncoder().encode(
      JSON.stringify(record),
    ).byteLength;
    const accepted = expectReady(
      await probeRecovery({
        indexedDb: new IDBFactory(),
        databaseName: "exact-budget",
        noteByteLimit: exactBytes,
        globalByteLimit: exactBytes,
      }),
    );
    await expect(accepted.prepareForward(record)).resolves.toEqual({
      kind: "written",
      byteUsage: { globalBytes: exactBytes, noteBytes: exactBytes },
    });
    await accepted.dispose();

    const rejected = expectReady(
      await probeRecovery({
        indexedDb: new IDBFactory(),
        databaseName: "over-budget",
        noteByteLimit: exactBytes - 1,
        globalByteLimit: exactBytes,
      }),
    );
    await expect(rejected.prepareForward(record)).resolves.toEqual({
      kind: "quota-exceeded",
    });
    await expect(rejected.getByteUsage(NOTE)).resolves.toEqual({
      globalBytes: 0,
      noteBytes: 0,
    });
    await rejected.dispose();
  });
});

describe("IndexedDB recovery integrity failures", () => {
  it("fails closed with an explicit result for corrupt durable data", async () => {
    const factory = new IDBFactory();
    const name = "corruption";
    const store = expectReady(
      await probeRecovery({ indexedDb: factory, databaseName: name }),
    );
    await store.prepareForward(preparedRecord());
    await store.dispose();
    const database = await openRawDatabase(
      factory,
      name,
      DATABASE_SCHEMA_VERSION,
    );
    await corruptFirstAttempt(database);
    database.close();

    const restarted = expectReady(
      await probeRecovery({ indexedDb: factory, databaseName: name }),
    );
    await expect(loadAndRelease(restarted, NOTE)).resolves.toMatchObject({
      kind: "corrupt",
    });
    await expect(
      restarted.recordForward({
        note: NOTE,
        attemptId: "attempt-1",
        expectedSessionOrder: 1,
        acknowledgement: {
          editorViewId: "view-1",
          effectId: "effect-1",
          direction: "forward",
          transactionSequence: 1,
        },
      }),
    ).resolves.toEqual({ kind: "concurrent-change" });
    await restarted.dispose();
  });

  it("maps backend loss to a read-only operation result", async () => {
    const factory = new IDBFactory();
    const name = "backend-loss";
    const store = expectReady(
      await probeRecovery({ indexedDb: factory, databaseName: name }),
    );
    const replacement = await openRawDatabase(
      factory,
      name,
      DATABASE_SCHEMA_VERSION + 1,
    );
    await expect(store.prepareForward(preparedRecord())).resolves.toEqual({
      kind: "backend-unavailable",
    });
    replacement.close();
    await store.dispose();
  });

  it("fails closed when persistent byte accounting is malformed", async () => {
    const factory = new IDBFactory();
    const name = "accounting-corruption";
    const store = expectReady(
      await probeRecovery({ indexedDb: factory, databaseName: name }),
    );
    await store.prepareForward(preparedRecord());
    const database = await openRawDatabase(
      factory,
      name,
      DATABASE_SCHEMA_VERSION,
    );
    const transaction = database.transaction("accounting", "readwrite");
    const completed = new Promise<void>((resolve) => {
      transaction.oncomplete = (): void => resolve();
    });
    transaction
      .objectStore("accounting")
      .put({ key: "global", bytes: "not-a-number" });
    await completed;
    database.close();

    await expect(store.getByteUsage(NOTE)).resolves.toEqual({
      kind: "backend-unavailable",
    });
    await expect(
      store.prepareForward(preparedRecord("attempt-2", 1 + 1)),
    ).resolves.toEqual({ kind: "backend-unavailable" });
    await store.dispose();
  });
});
