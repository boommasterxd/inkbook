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
import {
  getRecoveryByteUsage,
  loadRecoveryNote,
  type RecoveryLoadDataResult,
  type RecoveryTransactionObserver,
} from "./read-operations";
import { ACCOUNTING_STORE, ATTEMPTS_STORE, type StoredAttempt } from "./schema";
import { createStoredAttempt, validateStoredAttempt } from "./stored-attempt";
import type {
  DeleteAttemptRequest,
  PreparedForwardProbeRecord,
  RecordDirectionRequest,
  RecordForwardRequest,
  RecoveryByteUsage,
  RecoveryDeleteResult,
  RecoveryIndexedDbFaultInjector,
  RecoveryMutationResult,
  RecoveryNoteKey,
  RecoveryOperationFailure,
} from "./types";

interface TransactionConfiguration {
  readonly faultInjector?: RecoveryIndexedDbFaultInjector | undefined;
  readonly globalByteLimit: number;
  readonly noteByteLimit: number;
}

export class RecoveryTransactions {
  readonly #database: IDBDatabase;
  readonly #faultInjector: RecoveryIndexedDbFaultInjector | undefined;
  readonly #globalByteLimit: number;
  readonly #noteByteLimit: number;
  readonly #observer: RecoveryTransactionObserver;
  #active: IDBTransaction | undefined;

  public constructor(
    database: IDBDatabase,
    configuration: TransactionConfiguration,
  ) {
    this.#database = database;
    this.#faultInjector = configuration.faultInjector;
    this.#globalByteLimit = configuration.globalByteLimit;
    this.#noteByteLimit = configuration.noteByteLimit;
    this.#observer = {
      finish: (transaction): void => this.#finish(transaction),
      start: (transaction): void => this.#start(transaction),
    };
  }

  public abort(): void {
    try {
      this.#active?.abort();
    } catch {
      // The transaction reached a terminal state before disposal observed it.
    }
  }

  public loadNote(note: RecoveryNoteKey): Promise<RecoveryLoadDataResult> {
    return loadRecoveryNote(this.#database, note, this.#observer);
  }

  public getByteUsage(
    note: RecoveryNoteKey,
  ): Promise<RecoveryByteUsage | RecoveryOperationFailure> {
    return getRecoveryByteUsage(this.#database, note, this.#observer);
  }

  public async prepareForward(
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

  public async recordForward(
    request: RecordForwardRequest,
  ): Promise<RecoveryMutationResult> {
    const identifiers = resolveRequestIdentifiers(request);
    if (identifiers === null) return { kind: "invalid-input" };
    return this.#runMutation("record", async (transaction) => {
      const attempts = transaction.objectStore(ATTEMPTS_STORE);
      const value = await requestResult(
        attempts.get(identifiers.attemptKey) as IDBRequest<unknown>,
      );
      const validated = validateStoredAttempt(value, identifiers.attemptKey);
      if (validated === null) return { kind: "concurrent-change" };
      const usage = await readByteUsage(transaction, identifiers.noteKey);
      const replacement = createHostRecordedRecord(validated.record, request);
      if (replacement === null) return { kind: "concurrent-change" };
      if (recordsEqual(validated.record, replacement)) {
        return { kind: "unchanged", byteUsage: usage };
      }
      const serialized = encodeRecord(replacement);
      if (serialized === null) return { kind: "invalid-input" };
      return this.#writeAttempt(
        transaction,
        createStoredAttempt(
          identifiers.attemptKey,
          identifiers.noteKey,
          serialized,
        ),
        usage,
        validated.stored.byteSize,
      );
    });
  }

  public async recordDirection(
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

  public async deleteAttempt(
    request: DeleteAttemptRequest,
  ): Promise<RecoveryDeleteResult> {
    const identifiers = resolveRequestIdentifiers(request);
    if (identifiers === null) return { kind: "invalid-input" };
    return this.#runMutation("delete", async (transaction) => {
      const attempts = transaction.objectStore(ATTEMPTS_STORE);
      const value = await requestResult(
        attempts.get(identifiers.attemptKey) as IDBRequest<unknown>,
      );
      const usage = await readByteUsage(transaction, identifiers.noteKey);
      if (value === undefined) return { kind: "not-found", byteUsage: usage };
      const validated = validateStoredAttempt(value, identifiers.attemptKey);
      if (validated === null) return { kind: "concurrent-change" };
      const replacementUsage = addBytes(usage, -validated.stored.byteSize);
      if (replacementUsage === null) return { kind: "concurrent-change" };
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
    let transaction: IDBTransaction | undefined;
    try {
      transaction = this.#database.transaction(
        [ATTEMPTS_STORE, ACCOUNTING_STORE],
        "readwrite",
      );
      this.#start(transaction);
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
    } finally {
      if (transaction !== undefined) this.#finish(transaction);
    }
  }

  #start(transaction: IDBTransaction): void {
    this.#active = transaction;
  }

  #finish(transaction: IDBTransaction): void {
    if (this.#active === transaction) this.#active = undefined;
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
