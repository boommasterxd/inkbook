import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import {
  expectReady,
  loadAndRelease,
  NOTE,
  preparedRecord,
  probeRecovery,
} from "./support";

describe("IndexedDB recovery lifecycle", () => {
  it("survives prepared and host-recorded crash windows across restarts", async () => {
    const factory = new IDBFactory();
    const databaseName = "restart-windows";
    const first = expectReady(
      await probeRecovery({ indexedDb: factory, databaseName }),
    );
    await expect(first.prepareForward(preparedRecord())).resolves.toMatchObject(
      {
        kind: "written",
      },
    );
    await first.dispose();

    const second = expectReady(
      await probeRecovery({ indexedDb: factory, databaseName }),
    );
    await expect(loadAndRelease(second, NOTE)).resolves.toMatchObject({
      kind: "loaded",
      records: [{ kind: "prepared-forward" }],
    });
    await expect(
      second.recordForward({
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
    ).resolves.toMatchObject({ kind: "written" });
    await second.dispose();

    const third = expectReady(
      await probeRecovery({ indexedDb: factory, databaseName }),
    );
    await expect(loadAndRelease(third, NOTE)).resolves.toMatchObject({
      kind: "loaded",
      records: [{ kind: "host-recorded-forward" }],
    });
    await third.dispose();
  });

  it("deletes exactly one attempt and accounts only its encoded bytes", async () => {
    const store = expectReady(
      await probeRecovery({
        indexedDb: new IDBFactory(),
        databaseName: "exact-delete",
      }),
    );
    const first = await store.prepareForward(preparedRecord("attempt-1", 1));
    const second = await store.prepareForward(
      preparedRecord("attempt-2", 1 + 1, "larger-compact-patch"),
    );
    expect(first).toMatchObject({ kind: "written" });
    expect(second).toMatchObject({ kind: "written" });
    if (first.kind !== "written" || second.kind !== "written") {
      throw new Error("Expected both fixture writes to succeed");
    }

    const deletion = await store.deleteAttempt({
      note: NOTE,
      attemptId: "attempt-1",
    });
    expect(deletion).toEqual({
      kind: "deleted",
      byteUsage: {
        globalBytes: second.byteUsage.globalBytes - first.byteUsage.globalBytes,
        noteBytes: second.byteUsage.noteBytes - first.byteUsage.noteBytes,
      },
    });
    await expect(loadAndRelease(store, NOTE)).resolves.toMatchObject({
      kind: "loaded",
      records: [{ attemptId: "attempt-2" }],
    });
    await expect(
      store.deleteAttempt({ note: NOTE, attemptId: "attempt-1" }),
    ).resolves.toMatchObject({ kind: "not-found" });
    await store.dispose();
  });
});

describe("IndexedDB recovery disposal", () => {
  it("disposes idempotently, rejects queued work, and invokes no write hook", async () => {
    let callbackCount = 0;
    const store = expectReady(
      await probeRecovery({
        indexedDb: new IDBFactory(),
        databaseName: "disposal",
        faultInjector: {
          beforeCommit: () => {
            callbackCount += 1;
          },
        },
      }),
    );
    const queued = store.prepareForward(preparedRecord());
    const firstDisposal = store.dispose();
    const secondDisposal = store.dispose();
    await expect(queued).resolves.toEqual({ kind: "disposed" });
    await expect(Promise.all([firstDisposal, secondDisposal])).resolves.toEqual(
      [undefined, undefined],
    );
    expect(callbackCount).toBe(0);
    await expect(store.prepareForward(preparedRecord())).resolves.toEqual({
      kind: "disposed",
    });
  });
});
