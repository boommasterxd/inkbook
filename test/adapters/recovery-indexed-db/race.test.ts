import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import {
  expectReady,
  loadAndRelease,
  NOTE,
  preparedRecord,
  probeRecovery,
} from "./support";

describe("IndexedDB recovery concurrency", () => {
  it("serializes competing prepare writes and detects the losing session", async () => {
    const factory = new IDBFactory();
    const databaseName = "concurrent-prepare";
    const first = expectReady(
      await probeRecovery({ indexedDb: factory, databaseName }),
    );
    const second = expectReady(
      await probeRecovery({ indexedDb: factory, databaseName }),
    );

    const outcomes = await Promise.all([
      first.prepareForward(preparedRecord("attempt-1", 1, "first")),
      second.prepareForward(preparedRecord("attempt-1", 1, "second")),
    ]);
    expect(
      outcomes
        .map((outcome) => outcome.kind)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(["concurrent-change", "written"]);
    const snapshot = await loadAndRelease(first, NOTE);
    expect(snapshot).toMatchObject({ kind: "loaded" });
    if (snapshot.kind !== "loaded") {
      throw new Error("Expected one durable concurrent winner");
    }
    expect(snapshot.records).toHaveLength(1);
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it("enforces a durable monotonic session order even after cleanup", async () => {
    const store = expectReady(
      await probeRecovery({
        indexedDb: new IDBFactory(),
        databaseName: "session-order",
      }),
    );
    await expect(
      store.prepareForward(preparedRecord("attempt-2", 1 + 1)),
    ).resolves.toMatchObject({ kind: "written" });
    await store.deleteAttempt({ note: NOTE, attemptId: "attempt-2" });
    await expect(
      store.prepareForward(preparedRecord("attempt-1", 1)),
    ).resolves.toEqual({ kind: "concurrent-change" });
    await expect(
      store.prepareForward(preparedRecord("attempt-3", 1 + 1 + 1)),
    ).resolves.toMatchObject({ kind: "written" });
    await store.dispose();
  });
});

describe("IndexedDB recovery compare-and-swap", () => {
  it("makes one competing host acknowledgement durable and rejects the other", async () => {
    const factory = new IDBFactory();
    const databaseName = "concurrent-record";
    const first = expectReady(
      await probeRecovery({ indexedDb: factory, databaseName }),
    );
    const second = expectReady(
      await probeRecovery({ indexedDb: factory, databaseName }),
    );
    await first.prepareForward(preparedRecord());
    const base = {
      note: NOTE,
      attemptId: "attempt-1",
      expectedSessionOrder: 1,
    } as const;
    const outcomes = await Promise.all([
      first.recordForward({
        ...base,
        acknowledgement: {
          editorViewId: "view-1",
          effectId: "effect-1",
          direction: "forward",
          transactionSequence: 1,
        },
      }),
      second.recordForward({
        ...base,
        acknowledgement: {
          editorViewId: "view-2",
          effectId: "effect-2",
          direction: "forward",
          transactionSequence: 1,
        },
      }),
    ]);
    expect(
      outcomes
        .map((outcome) => outcome.kind)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(["concurrent-change", "written"]);
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it("treats exact prepare and acknowledgement retries as idempotent", async () => {
    const store = expectReady(
      await probeRecovery({
        indexedDb: new IDBFactory(),
        databaseName: "idempotent-retry",
      }),
    );
    const record = preparedRecord();
    await store.prepareForward(record);
    await expect(store.prepareForward(record)).resolves.toMatchObject({
      kind: "unchanged",
    });
    const transition = {
      note: NOTE,
      attemptId: "attempt-1",
      expectedSessionOrder: 1,
      acknowledgement: {
        editorViewId: "view-1",
        effectId: "effect-1",
        direction: "forward",
        transactionSequence: 1,
      },
    } as const;
    await store.recordForward(transition);
    await expect(store.recordForward(transition)).resolves.toMatchObject({
      kind: "unchanged",
    });
    await store.dispose();
  });
});
