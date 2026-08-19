import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import {
  expectReady,
  loadAndRelease,
  NOTE,
  preparedRecord,
  probeRecovery,
} from "./support";

describe("IndexedDB recovery input boundaries", () => {
  it("rejects malformed record and note identities without durable writes", async () => {
    const store = expectReady(
      await probeRecovery({
        indexedDb: new IDBFactory(),
        databaseName: "invalid-input",
      }),
    );
    await expect(
      store.prepareForward({
        ...preparedRecord(),
        note: { ...NOTE, markdownPath: "" },
      }),
    ).resolves.toEqual({ kind: "invalid-input" });
    await expect(
      store.prepareForward({ ...preparedRecord(), attemptId: "" }),
    ).resolves.toEqual({ kind: "invalid-input" });
    await expect(
      store.prepareForward({ ...preparedRecord(), sessionOrder: 0 }),
    ).resolves.toEqual({ kind: "invalid-input" });
    const recordWithForbiddenField = {
      ...preparedRecord(),
      markdownText: "must not enter recovery storage",
    };
    await expect(
      store.prepareForward(recordWithForbiddenField),
    ).resolves.toEqual({ kind: "invalid-input" });
    await expect(
      loadAndRelease(store, { ...NOTE, vaultIdentityHint: "" }),
    ).resolves.toEqual({ kind: "invalid-input" });
    await expect(
      store.getByteUsage({ ...NOTE, markdownPath: "" }),
    ).resolves.toEqual({ kind: "invalid-input" });
    await expect(
      store.deleteAttempt({ note: NOTE, attemptId: "" }),
    ).resolves.toEqual({ kind: "invalid-input" });
    await store.dispose();
  });

  it("rejects stale and malformed host transitions without replacing prepared data", async () => {
    const store = expectReady(
      await probeRecovery({
        indexedDb: new IDBFactory(),
        databaseName: "invalid-transition",
      }),
    );
    await store.prepareForward(preparedRecord());
    await expect(
      store.recordForward({
        note: NOTE,
        attemptId: "attempt-1",
        expectedSessionOrder: 0,
        acknowledgement: {
          editorViewId: "view-1",
          effectId: "effect-1",
          direction: "forward",
          transactionSequence: 1,
        },
      }),
    ).resolves.toEqual({ kind: "concurrent-change" });
    await expect(
      store.recordForward({
        note: NOTE,
        attemptId: "attempt-1",
        expectedSessionOrder: 1,
        acknowledgement: {
          editorViewId: "view-1",
          effectId: "effect-1",
          direction: "forward",
          transactionSequence: 0,
        },
      }),
    ).resolves.toEqual({ kind: "invalid-input" });
    await expect(
      store.recordForward({
        note: NOTE,
        attemptId: "missing",
        expectedSessionOrder: 1,
        acknowledgement: {
          editorViewId: "view-1",
          effectId: "effect-1",
          direction: "forward",
          transactionSequence: 1,
        },
      }),
    ).resolves.toEqual({ kind: "concurrent-change" });
    await expect(loadAndRelease(store, NOTE)).resolves.toMatchObject({
      kind: "loaded",
      records: [{ kind: "prepared-forward" }],
    });
    await store.dispose();
  });
});

describe("IndexedDB recovery global budget", () => {
  it("accounts UTF-8 bytes across notes and rolls back the first over-limit write", async () => {
    const first = preparedRecord();
    const second = {
      ...preparedRecord("attempt-2"),
      note: { ...NOTE, markdownPath: "notes/zweite-Notiz-ä.md" },
    };
    const firstBytes = new TextEncoder().encode(
      JSON.stringify(first),
    ).byteLength;
    const secondBytes = new TextEncoder().encode(
      JSON.stringify(second),
    ).byteLength;
    const store = expectReady(
      await probeRecovery({
        indexedDb: new IDBFactory(),
        databaseName: "global-budget",
        globalByteLimit: firstBytes + secondBytes - 1,
        noteByteLimit: Math.max(firstBytes, secondBytes),
      }),
    );
    await expect(store.prepareForward(first)).resolves.toMatchObject({
      kind: "written",
      byteUsage: { globalBytes: firstBytes, noteBytes: firstBytes },
    });
    await expect(store.prepareForward(second)).resolves.toEqual({
      kind: "quota-exceeded",
    });
    await expect(loadAndRelease(store, second.note)).resolves.toEqual({
      kind: "loaded",
      records: [],
    });
    await expect(store.getByteUsage(NOTE)).resolves.toEqual({
      globalBytes: firstBytes,
      noteBytes: firstBytes,
    });
    await store.dispose();
  });
});
