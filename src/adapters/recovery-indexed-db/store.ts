import {
  addBytes,
  readByteUsage,
  readSessionOrderHighWater,
  writeByteUsage,
  writeSessionOrderHighWater,
} from "./accounting";
import { mapIndexedDbFailure } from "./error-mapping";
import { requestResult, transactionDone } from "./idb-promises";
import { encodeRecord, recordsEqual } from "./record-codec";
import {
  createHostRecordedRecord,
  resolveDirectionIdentifiers,
  resolvePreparedIdentifiers,
  resolveRequestIdentifiers,
} from "./record-transitions";
import { getRecoveryByteUsage, loadRecoveryNote } from "./read-operations";
import { ACCOUNTING_STORE, ATTEMPTS_STORE, type StoredAttempt } from "./schema";
import { createStoredAttempt, validateStoredAttempt } from "./stored-attempt";
import {
  DEFAULT_GLOBAL_BYTE_LIMIT,
  DEFAULT_NOTE_BYTE_LIMIT,
  type DeleteAttemptRequest,
  type PreparedForwardProbeRecord,
  type RecordDirectionRequest,
  type RecordForwardRequest,
  type RecoveryByteUsage,
  type RecoveryDeleteResult,
  type RecoveryIndexedDbFaultInjector,
  type RecoveryIndexedDbStore,
  type RecoveryLoadResult,
  type RecoveryMutationResult,
  type RecoveryNoteKey,
  type RecoveryOperationFailure,
} from "./types";

interface StoreConfiguration {
  readonly globalByteLimit?: number | undefined;
  readonly noteByteLimit?: number | undefined;
  readonly faultInjector?: RecoveryIndexedDbFaultInjector | undefined;
}

export class IndexedDbRecoveryStore implements RecoveryIndexedDbStore {
  readonly #database: IDBDatabase;
  readonly #globalByteLimit: number;
  readonly #noteByteLimit: number;
  readonly #faultInjector: RecoveryIndexedDbFaultInjector | undefined;
  #disposed = false;
  #tail: Promise<void> = Promise.resolve();

  public constructor(database: IDBDatabase, configuration: StoreConfiguration) {
    this.#database = database;
    this.#globalByteLimit =
      configuration.globalByteLimit ?? DEFAULT_GLOBAL_BYTE_LIMIT;
    this.#noteByteLimit =
      configuration.noteByteLimit ?? DEFAULT_NOTE_BYTE_LIMIT;
    this.#faultInjector = configuration.faultInjector;
    this.#database.addEventListener("versionchange", () =>
      this.#database.close(),
    );
  }

  public prepareForward(
    record: PreparedForwardProbeRecord,
  ): Promise<RecoveryMutationResult> {
    return this.#enqueue(() => this.#prepareForward(record));
  }

  public recordForward(
    request: RecordForwardRequest,
  ): Promise<RecoveryMutationResult> {
    return this.#enqueue(() => this.#recordForward(request));
  }

  public recordDirection(
    record: RecordDirectionRequest,
  ): Promise<RecoveryMutationResult> {
    return this.#enqueue(() => this.#recordDirection(record));
  }

  public loadNote(note: RecoveryNoteKey): Promise<RecoveryLoadResult> {
    return this.#enqueue(() => loadRecoveryNote(this.#database, note));
  }

  public deleteAttempt(
    request: DeleteAttemptRequest,
  ): Promise<RecoveryDeleteResult> {
    return this.#enqueue(() => this.#deleteAttempt(request));
  }

  public getByteUsage(
    note: RecoveryNoteKey,
  ): Promise<RecoveryByteUsage | RecoveryOperationFailure> {
    return this.#enqueue(() => getRecoveryByteUsage(this.#database, note));
  }

  public async dispose(): Promise<void> {
    if (!this.#disposed) {
      this.#disposed = true;
      await this.#tail;
      this.#database.close();
      return;
    }
    await this.#tail;
  }

  async #prepareForward(
    record: PreparedForwardProbeRecord,
  ): Promise<RecoveryMutationResult> {
    const identifiers = resolvePreparedIdentifiers(record);
    const serialized = encodeRecord(record);
    if (identifiers === null || serialized === null) {
      return { kind: "invalid-input" };
    }
    const stored = createStoredAttempt(
      identifiers.attemptKey,
      identifiers.noteKey,
      serialized,
    );
    return this.#runMutation("prepare", async (transaction) => {
      const attempts = transaction.objectStore(ATTEMPTS_STORE);
      const existing = await requestResult(
        attempts.get(stored.key) as IDBRequest<unknown>,
      );
      const usage = await readByteUsage(transaction, stored.noteKey);
      if (existing !== undefined) {
        const validated = validateStoredAttempt(existing, stored.key);
        return validated?.stored.serialized === serialized
          ? { kind: "unchanged", byteUsage: usage }
          : { kind: "concurrent-change" };
      }
      const highWater = await readSessionOrderHighWater(
        transaction,
        stored.noteKey,
      );
      if (record.sessionOrder <= highWater) {
        return { kind: "concurrent-change" };
      }
      writeSessionOrderHighWater(
        transaction,
        stored.noteKey,
        record.sessionOrder,
      );
      return this.#writeAttempt(transaction, stored, usage, 0);
    });
  }

  async #recordForward(
    request: RecordForwardRequest,
  ): Promise<RecoveryMutationResult> {
    const identifiers = resolveRequestIdentifiers(request);
    if (identifiers === null) {
      return { kind: "invalid-input" };
    }
    return this.#runMutation("record", async (transaction) => {
      const attempts = transaction.objectStore(ATTEMPTS_STORE);
      const value = await requestResult(
        attempts.get(identifiers.attemptKey) as IDBRequest<unknown>,
      );
      const validated = validateStoredAttempt(value, identifiers.attemptKey);
      if (validated === null) {
        return { kind: "concurrent-change" };
      }
      const usage = await readByteUsage(transaction, identifiers.noteKey);
      const replacement = createHostRecordedRecord(validated.record, request);
      if (replacement === null) {
        return { kind: "concurrent-change" };
      }
      if (recordsEqual(validated.record, replacement)) {
        return { kind: "unchanged", byteUsage: usage };
      }
      const serialized = encodeRecord(replacement);
      if (serialized === null) {
        return { kind: "invalid-input" };
      }
      const stored = createStoredAttempt(
        identifiers.attemptKey,
        identifiers.noteKey,
        serialized,
      );
      return this.#writeAttempt(
        transaction,
        stored,
        usage,
        validated.stored.byteSize,
      );
    });
  }

  async #recordDirection(
    record: RecordDirectionRequest,
  ): Promise<RecoveryMutationResult> {
    const identifiers = resolveDirectionIdentifiers(record);
    const serialized = encodeRecord(record);
    if (identifiers === null || serialized === null) {
      return { kind: "invalid-input" };
    }
    const stored = createStoredAttempt(
      identifiers.attemptKey,
      identifiers.noteKey,
      serialized,
    );
    return this.#runMutation("direction", async (transaction) => {
      const attempts = transaction.objectStore(ATTEMPTS_STORE);
      const existing = await requestResult(
        attempts.get(stored.key) as IDBRequest<unknown>,
      );
      const usage = await readByteUsage(transaction, stored.noteKey);
      if (existing !== undefined) {
        const validated = validateStoredAttempt(existing, stored.key);
        return validated?.stored.serialized === serialized
          ? { kind: "unchanged", byteUsage: usage }
          : { kind: "concurrent-change" };
      }
      const highWater = await readSessionOrderHighWater(
        transaction,
        stored.noteKey,
      );
      if (record.sessionOrder <= highWater) {
        return { kind: "concurrent-change" };
      }
      writeSessionOrderHighWater(
        transaction,
        stored.noteKey,
        record.sessionOrder,
      );
      return this.#writeAttempt(transaction, stored, usage, 0);
    });
  }

  async #deleteAttempt(
    request: DeleteAttemptRequest,
  ): Promise<RecoveryDeleteResult> {
    const identifiers = resolveRequestIdentifiers(request);
    if (identifiers === null) {
      return { kind: "invalid-input" };
    }
    return this.#runMutation("delete", async (transaction) => {
      const attempts = transaction.objectStore(ATTEMPTS_STORE);
      const value = await requestResult(
        attempts.get(identifiers.attemptKey) as IDBRequest<unknown>,
      );
      const usage = await readByteUsage(transaction, identifiers.noteKey);
      if (value === undefined) {
        return { kind: "not-found", byteUsage: usage };
      }
      const validated = validateStoredAttempt(value, identifiers.attemptKey);
      if (validated === null) {
        return { kind: "concurrent-change" };
      }
      const replacementUsage = addBytes(usage, -validated.stored.byteSize);
      if (replacementUsage === null) {
        return { kind: "concurrent-change" };
      }
      attempts.delete(identifiers.attemptKey);
      writeByteUsage(transaction, identifiers.noteKey, replacementUsage);
      return { kind: "deleted", byteUsage: replacementUsage };
    });
  }

  #writeAttempt(
    transaction: IDBTransaction,
    stored: StoredAttempt,
    usage: RecoveryByteUsage,
    replacedBytes: number,
  ): RecoveryMutationResult {
    const replacementUsage = addBytes(usage, stored.byteSize - replacedBytes);
    if (
      replacementUsage === null ||
      replacementUsage.globalBytes > this.#globalByteLimit ||
      replacementUsage.noteBytes > this.#noteByteLimit
    ) {
      return { kind: "quota-exceeded" };
    }
    transaction.objectStore(ATTEMPTS_STORE).put(stored);
    writeByteUsage(transaction, stored.noteKey, replacementUsage);
    return { kind: "written", byteUsage: replacementUsage };
  }

  async #runMutation<T extends RecoveryMutationResult | RecoveryDeleteResult>(
    operation: "prepare" | "record" | "direction" | "delete",
    work: (transaction: IDBTransaction) => Promise<T> | T,
  ): Promise<T | RecoveryOperationFailure> {
    let done: Promise<void> | undefined;
    try {
      const transaction = this.#database.transaction(
        [ATTEMPTS_STORE, ACCOUNTING_STORE],
        "readwrite",
      );
      done = transactionDone(transaction);
      const result = await work(transaction);
      if (!isSuccessfulMutation(result)) {
        transaction.abort();
        await done.catch(() => undefined);
        return result;
      }
      this.#injectFault(operation, transaction);
      await done;
      return result;
    } catch (error) {
      await done?.catch(() => undefined);
      return mapIndexedDbFailure(error);
    }
  }

  #injectFault(
    operation: "prepare" | "record" | "direction" | "delete",
    transaction: IDBTransaction,
  ): void {
    try {
      this.#faultInjector?.beforeCommit(operation, transaction);
    } catch (error) {
      transaction.abort();
      throw error;
    }
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T | RecoveryOperationFailure> {
    if (this.#disposed) {
      return Promise.resolve({ kind: "disposed" });
    }
    const result = this.#tail.then(async () => {
      if (this.#disposed) {
        return { kind: "disposed" } as const;
      }
      return work();
    });
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function isSuccessfulMutation(
  result: RecoveryMutationResult | RecoveryDeleteResult,
): boolean {
  return (
    result.kind === "written" ||
    result.kind === "unchanged" ||
    result.kind === "deleted" ||
    result.kind === "not-found"
  );
}
