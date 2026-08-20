/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact recovery resource boundaries are the behavior under test. */
import { describe, expect, it } from "vitest";

import {
  RECOVERY_STORE_LIMITS_V1,
  encodeRecoveryRecordV1,
} from "../../../src/application/recovery";
import {
  createSidecarRevision,
  createSourceGeneration,
  parseSha256Digest,
} from "../../../src/application/note-session";
import { createSceneRevision } from "../../../src/domain/model";
import { encodeCanonicalJson } from "../../../src/domain/codecs/canonical-json";
import { DATABASE_SCHEMA_VERSION } from "../../../src/adapters/recovery-indexed-db";
import {
  BASE,
  DIGEST_A,
  corruptStoredRecord,
  corruptStoredSha256,
  existingLoad,
  hostAcknowledgement,
  openRawDatabase,
  openStore,
  preparedAttempt,
  replaceStoredEncoded,
} from "./support";

// eslint-disable-next-line max-lines-per-function -- The resource scenarios form one cohesive boundary suite.
describe("IndexedDB recovery limits", () => {
  it("freezes the normative global, note, and direct-successor limits", () => {
    expect(RECOVERY_STORE_LIMITS_V1).toEqual({
      maxDirectSuccessorsPerBase: 512,
      maxGlobalBytes: 32 * 1024 * 1024,
      maxGlobalRecords: 16_384,
      maxNoteBytes: 8 * 1024 * 1024,
      maxNoteRecords: 4096,
    });
  });

  it("accepts exact UTF-8 byte capacity and rejects one byte below it", async () => {
    const attempt = preparedAttempt();
    const encoded = encodeRecoveryRecordV1(attempt);
    if (!encoded.ok) throw new Error("Expected attempt encoding.");
    const exact = await openStore("exact-byte-limit", {
      limits: {
        globalBytes: encoded.value.byteLength,
        noteBytes: encoded.value.byteLength,
      },
    });
    await expect(exact.store.prepareForward(attempt)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await exact.store.dispose();

    const below = await openStore("below-byte-limit", {
      limits: {
        globalBytes: encoded.value.byteLength,
        noteBytes: encoded.value.byteLength - 1,
      },
    });
    await expect(below.store.prepareForward(attempt)).resolves.toEqual({
      ok: false,
      code: "recovery-limit",
    });
    await below.store.dispose();
  });

  it("tests below, at, and above global and per-note record admissions", async () => {
    const { store } = await openStore("record-limits", {
      limits: { globalRecords: 3, noteRecords: 2 },
    });
    await expect(
      store.prepareForward(preparedAttempt(1, 1)),
    ).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      store.prepareForward(preparedAttempt(2, 2)),
    ).resolves.toMatchObject({
      ok: true,
    });
    await expect(store.prepareForward(preparedAttempt(3, 3))).resolves.toEqual({
      ok: false,
      code: "recovery-limit",
    });
    await store.dispose();

    const global = await openStore("global-record-limit", {
      limits: { globalRecords: 3, noteRecords: 3 },
    });
    const otherBase = {
      ...BASE,
      markdownPath: "notes/other.md",
      vaultRelativePath: "notes/other.inkbook.json",
    };
    await global.store.prepareForward(preparedAttempt(10, 1));
    await global.store.prepareForward(preparedAttempt(11, 2));
    await expect(
      global.store.prepareForward(preparedAttempt(12, 1, otherBase)),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      global.store.prepareForward(preparedAttempt(13, 2, otherBase)),
    ).resolves.toEqual({ ok: false, code: "recovery-limit" });
    await global.store.dispose();
  });

  it("admits exactly 4,096 note records and rejects record 4,097", async () => {
    const name = "normative-note-record-limit";
    const opened = await openStore(name);
    for (let count = 1; count <= 4095; count += 1) {
      const result = await opened.store.prepareForward(
        preparedAttempt(count, count, distinctBase(count)),
      );
      expect(result.ok).toBe(true);
    }
    await expect(
      countIndexedRecords(opened.factory, name, "noteKey", BASE.markdownPath),
    ).resolves.toBe(4095);
    await expect(
      opened.store.prepareForward(
        preparedAttempt(4096, 4096, distinctBase(4096)),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      countIndexedRecords(opened.factory, name, "noteKey", BASE.markdownPath),
    ).resolves.toBe(4096);
    await expect(
      opened.store.prepareForward(
        preparedAttempt(4097, 4097, distinctBase(4097)),
      ),
    ).resolves.toEqual({ ok: false, code: "recovery-limit" });
    await expect(
      countIndexedRecords(opened.factory, name, "noteKey", BASE.markdownPath),
    ).resolves.toBe(4096);
    await opened.store.dispose();
  }, 30_000);

  it("admits exactly 16,384 global records and rejects record 16,385", async () => {
    const name = "normative-global-record-limit";
    const opened = await openStore(name);
    for (let count = 1; count <= 16_383; count += 1) {
      const noteIndex = (count - 1) % 4;
      const sessionOrder = Math.floor((count - 1) / 4) + 1;
      const result = await opened.store.prepareForward(
        preparedAttempt(
          count,
          sessionOrder,
          distinctNoteBase(count, noteIndex, sessionOrder),
        ),
      );
      expect(result.ok).toBe(true);
    }
    await expect(countAllRecords(opened.factory, name)).resolves.toBe(16_383);
    await expect(
      opened.store.prepareForward(
        preparedAttempt(16_384, 4096, distinctNoteBase(16_384, 3, 4096)),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(countAllRecords(opened.factory, name)).resolves.toBe(16_384);
    await expect(
      opened.store.prepareForward(
        preparedAttempt(16_385, 4097, distinctNoteBase(16_385, 0, 4097)),
      ),
    ).resolves.toEqual({ ok: false, code: "recovery-limit" });
    await expect(countAllRecords(opened.factory, name)).resolves.toBe(16_384);
    await opened.store.dispose();
  }, 60_000);

  it("admits and cleans exactly 512 direct successors, rejecting the 513th", async () => {
    const name = "direct-successor-limit";
    const { store, factory } = await openStore(name);
    const covered = [];
    for (let index = 1; index <= 511; index += 1) {
      const attempt = preparedAttempt(index, index);
      covered.push(attempt.attemptId);
      const result = await store.prepareForward(attempt);
      expect(result.ok).toBe(true);
    }
    const belowLimit = await store.loadNote(existingLoad());
    expect(belowLimit.ok && belowLimit.value.attempts).toHaveLength(511);
    const finalAttempt = preparedAttempt(512, 512);
    covered.push(finalAttempt.attemptId);
    await expect(store.prepareForward(finalAttempt)).resolves.toMatchObject({
      ok: true,
    });
    const atLimit = await store.loadNote(existingLoad());
    expect(atLimit.ok && atLimit.value.attempts).toHaveLength(512);
    await expect(
      store.prepareForward(preparedAttempt(513, 513)),
    ).resolves.toEqual({
      ok: false,
      code: "recovery-limit",
    });
    const afterRejection = await store.loadNote(existingLoad());
    expect(afterRejection.ok && afterRejection.value.attempts).toHaveLength(
      512,
    );
    const unrelated = preparedAttempt(514, 513, distinctBase(514));
    await expect(store.prepareForward(unrelated)).resolves.toMatchObject({
      ok: true,
    });
    await corruptStoredRecord(factory, name, `attempt:${unrelated.attemptId}`);
    await expect(
      store.acknowledgeSidecar({
        acknowledgedReplacementBase: {
          ...BASE,
          rawTextSha256: DIGEST_A,
          revision: createSidecarRevision(2),
        },
        coveredAttemptIds: covered,
        coveredCheckpointIds: [],
        expectedPriorBase: BASE,
        noteIdentity: {
          vaultIdHint: "vault-fixture",
          vaultRelativeMarkdownPath: BASE.markdownPath,
        },
        sceneRevision: createSceneRevision(2),
        sidecarRevision: createSidecarRevision(2),
        sourceDigest: DIGEST_A,
        sourceGeneration: createSourceGeneration(1),
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    await expect(countAllRecords(factory, name)).resolves.toBe(1);
    await expect(
      countIndexedRecords(factory, name, "successorKey", successorKey(BASE)),
    ).resolves.toBe(0);
    await store.dispose();
  }, 30_000);
});

describe("IndexedDB recovery integrity", () => {
  it("rejects a canonical prepared record whose inverse does not match its forward patch", async () => {
    const name = "invalid-recovery-inverse";
    const { store, factory } = await openStore(name);
    const attempt = preparedAttempt();
    await store.prepareForward(attempt);
    await expect(store.loadNote(existingLoad())).resolves.toMatchObject({
      ok: true,
      value: { attempts: [{ attemptId: attempt.attemptId }] },
    });

    const encoded = encodeCanonicalJson({
      record: { ...attempt, inverse: attempt.forward },
      recordType: "attempt",
      schemaVersion: 1,
    });
    await replaceStoredEncoded(
      factory,
      name,
      `attempt:${attempt.attemptId}`,
      encoded,
    );
    await expect(store.loadNote(existingLoad())).resolves.toEqual({
      ok: false,
      code: "recovery-unavailable",
    });
    await store.dispose();
  });

  it("rejects SHA-only corruption on idempotent append and load", async () => {
    const name = "corrupt-record-sha";
    const { store, factory } = await openStore(name);
    const attempt = preparedAttempt();
    await store.prepareForward(attempt);
    await corruptStoredSha256(factory, name, `attempt:${attempt.attemptId}`);

    await expect(store.prepareForward(attempt)).resolves.toEqual({
      ok: false,
      code: "recovery-unavailable",
    });
    await expect(store.loadNote(existingLoad())).resolves.toEqual({
      ok: false,
      code: "recovery-unavailable",
    });
    await store.dispose();
  });
});

describe("IndexedDB recovery faults", () => {
  it("rolls back abort and quota failures before durable publication", async () => {
    let failure: "abort" | "quota" | null = "abort";
    const { store } = await openStore("fault-rollback", {
      faultInjector: {
        beforeCommit: (_operation, transaction) => {
          if (failure === "abort") transaction.abort();
          if (failure === "quota") {
            throw new DOMException("Fixture quota.", "QuotaExceededError");
          }
        },
      },
    });
    await expect(store.prepareForward(preparedAttempt())).resolves.toEqual({
      ok: false,
      code: "recovery-unavailable",
    });
    failure = "quota";
    await expect(store.prepareForward(preparedAttempt())).resolves.toEqual({
      ok: false,
      code: "recovery-limit",
    });
    failure = null;
    await expect(store.loadNote(existingLoad())).resolves.toMatchObject({
      ok: true,
      value: { attempts: [] },
    });
    await store.dispose();
  });

  it("fails closed on corrupt records without exposing partial recovery", async () => {
    const name = "corrupt-record";
    const { store, factory } = await openStore(name);
    await store.prepareForward(preparedAttempt());
    await store.dispose();
    const database = await openRawDatabase(
      factory,
      name,
      DATABASE_SCHEMA_VERSION,
    );
    const transaction = database.transaction("records", "readwrite");
    const records = transaction.objectStore("records");
    const request = records.openCursor();
    await new Promise<void>((resolve, reject) => {
      request.addEventListener("success", () => {
        const cursor = request.result;
        if (cursor === null) {
          reject(new Error("Expected stored record."));
          return;
        }
        const value = cursor.value as Record<string, unknown>;
        cursor.update({ ...value, encoded: new Uint8Array([123]) });
        resolve();
      });
      request.addEventListener("error", () =>
        reject(request.error ?? new DOMException("Cursor failed.")),
      );
    });
    await new Promise<void>((resolve) => {
      transaction.addEventListener("complete", () => resolve());
    });
    database.close();

    const reopened = await openStore(name, {}, factory);
    await expect(reopened.store.loadNote(existingLoad())).resolves.toEqual({
      ok: false,
      code: "recovery-unavailable",
    });
    await expect(
      reopened.store.recordForward(
        preparedAttempt().attemptId,
        hostAcknowledgement(),
      ),
    ).resolves.toEqual({ ok: false, code: "recovery-unavailable" });
    await reopened.store.dispose();
  });
});

function distinctBase(index: number): typeof BASE {
  return {
    ...BASE,
    rawTextSha256: parseSha256Digest(index.toString(16).padStart(64, "0")),
    revision: createSidecarRevision(index),
  };
}

function distinctNoteBase(
  globalIndex: number,
  noteIndex: number,
  revision: number,
): typeof BASE {
  const markdownPath = `notes/global-${String(noteIndex)}.md`;
  return {
    markdownPath,
    rawTextSha256: parseSha256Digest(
      globalIndex.toString(16).padStart(64, "0"),
    ),
    revision: createSidecarRevision(revision),
    vaultRelativePath: `notes/global-${String(noteIndex)}.inkbook.json`,
  };
}

async function countIndexedRecords(
  factory: IDBFactory,
  name: string,
  indexName: string,
  query: IDBValidKey,
): Promise<number> {
  const database = await openRawDatabase(
    factory,
    name,
    DATABASE_SCHEMA_VERSION,
  );
  const transaction = database.transaction("records", "readonly");
  const request = transaction
    .objectStore("records")
    .index(indexName)
    .count(query);
  const count = await new Promise<number>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new DOMException("Count failed.")),
    );
  });
  database.close();
  return count;
}

function successorKey(base: typeof BASE): string {
  return JSON.stringify([
    base.markdownPath,
    base.vaultRelativePath,
    base.revision,
    base.rawTextSha256,
    base.markdownPath,
  ]);
}

async function countAllRecords(
  factory: IDBFactory,
  name: string,
): Promise<number> {
  const database = await openRawDatabase(
    factory,
    name,
    DATABASE_SCHEMA_VERSION,
  );
  const transaction = database.transaction("records", "readonly");
  const request = transaction.objectStore("records").count();
  const count = await new Promise<number>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new DOMException("Count failed.")),
    );
  });
  database.close();
  return count;
}
