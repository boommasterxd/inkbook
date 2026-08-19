import type {
  BatchResourceHandleV1,
  ResourceCoordinatorV1,
} from "../../application/resource-coordinator";
import { mapIndexedDbFailure } from "./error-mapping";
import { recoveryNoteKey } from "./record-codec";
import type { RecoveryLoadDataResult } from "./read-operations";
import {
  admitRecoveryQueueOperation,
  completeRecoveryReservation,
  type RecoveryQueueReservation,
  type RecoveryResourceCharge,
} from "./resource-admission";
import {
  LOAD_COMPLETION_BYTES,
  measureForwardRequestCharge,
  measureNoteRequestCharge,
  measureRecordCharge,
  type MeasuredRecoveryCharge,
} from "./resource-charge";
import { RecoveryTransactions } from "./transactions";
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
  readonly databaseName: string;
  readonly faultInjector?: RecoveryIndexedDbFaultInjector | undefined;
  readonly globalByteLimit?: number | undefined;
  readonly listenerHandle: BatchResourceHandleV1;
  readonly noteByteLimit?: number | undefined;
  readonly resourceCoordinator: ResourceCoordinatorV1;
}

type InternalOperationResult =
  | RecoveryMutationResult
  | RecoveryDeleteResult
  | RecoveryLoadDataResult
  | RecoveryByteUsage;

interface PendingOperation {
  readonly execute: () => Promise<InternalOperationResult>;
  readonly kind: RecoveryOperationKind;
  readonly ownerId: string;
  readonly reservation: RecoveryQueueReservation;
  readonly resolve: (
    result: InternalOperationResult | RecoveryOperationFailure,
  ) => void;
}

type RecoveryOperationKind =
  "prepare" | "record" | "direction" | "load" | "usage" | "delete";

export class IndexedDbRecoveryStore implements RecoveryIndexedDbStore {
  readonly #database: IDBDatabase;
  readonly #databaseName: string;
  readonly #faultInjector: RecoveryIndexedDbFaultInjector | undefined;
  readonly #listenerHandle: BatchResourceHandleV1;
  readonly #queue: PendingOperation[] = [];
  readonly #resources: ResourceCoordinatorV1;
  readonly #transactions: RecoveryTransactions;
  readonly #versionChangeHandler = (): void => this.#handleVersionChange();
  #active: PendingOperation | undefined;
  #backendAvailable = true;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;
  #resolveDisposal: (() => void) | undefined;
  #nextOperationId = 1;

  public constructor(database: IDBDatabase, configuration: StoreConfiguration) {
    this.#database = database;
    this.#databaseName = configuration.databaseName;
    this.#faultInjector = configuration.faultInjector;
    this.#listenerHandle = configuration.listenerHandle;
    this.#resources = configuration.resourceCoordinator;
    this.#transactions = new RecoveryTransactions(database, {
      faultInjector: configuration.faultInjector,
      globalByteLimit:
        configuration.globalByteLimit ?? DEFAULT_GLOBAL_BYTE_LIMIT,
      noteByteLimit: configuration.noteByteLimit ?? DEFAULT_NOTE_BYTE_LIMIT,
    });
    this.#database.addEventListener(
      "versionchange",
      this.#versionChangeHandler,
    );
  }

  public prepareForward(
    record: PreparedForwardProbeRecord,
  ): Promise<RecoveryMutationResult> {
    const scopeId = recoveryNoteKey(record.note);
    const charge = measureRecordCharge(record);
    if (scopeId === null || charge === null) return invalidResult();
    return this.#enqueue("prepare", scopeId, charge, () =>
      this.#transactions.prepareForward(record),
    );
  }

  public recordForward(
    request: RecordForwardRequest,
  ): Promise<RecoveryMutationResult> {
    const scopeId = recoveryNoteKey(request.note);
    const charge = measureForwardRequestCharge(request);
    if (scopeId === null || charge === null) return invalidResult();
    return this.#enqueue("record", scopeId, charge, () =>
      this.#transactions.recordForward(request),
    );
  }

  public recordDirection(
    record: RecordDirectionRequest,
  ): Promise<RecoveryMutationResult> {
    const scopeId = recoveryNoteKey(record.note);
    const charge = measureRecordCharge(record);
    if (scopeId === null || charge === null) return invalidResult();
    return this.#enqueue("direction", scopeId, charge, () =>
      this.#transactions.recordDirection(record),
    );
  }

  public loadNote(note: RecoveryNoteKey): Promise<RecoveryLoadResult> {
    const scopeId = recoveryNoteKey(note);
    const charge = measureNoteRequestCharge(note, LOAD_COMPLETION_BYTES);
    if (scopeId === null || charge === null) return invalidResult();
    return this.#enqueue("load", scopeId, charge, () =>
      this.#transactions.loadNote(note),
    ) as Promise<RecoveryLoadResult>;
  }

  public deleteAttempt(
    request: DeleteAttemptRequest,
  ): Promise<RecoveryDeleteResult> {
    const scopeId = recoveryNoteKey(request.note);
    const charge = measureNoteRequestCharge(request);
    if (scopeId === null || charge === null) return invalidResult();
    return this.#enqueue("delete", scopeId, charge, () =>
      this.#transactions.deleteAttempt(request),
    );
  }

  public getByteUsage(
    note: RecoveryNoteKey,
  ): Promise<RecoveryByteUsage | RecoveryOperationFailure> {
    const scopeId = recoveryNoteKey(note);
    const charge = measureNoteRequestCharge(note);
    if (scopeId === null || charge === null) return invalidResult();
    return this.#enqueue("usage", scopeId, charge, () =>
      this.#transactions.getByteUsage(note),
    );
  }

  public dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    this.#disposed = true;
    this.#disposePromise = new Promise<void>((resolve) => {
      this.#resolveDisposal = resolve;
    });
    this.#cancelQueued({ kind: "disposed" });
    this.#transactions.abort();
    this.#finishDisposalIfIdle();
    return this.#disposePromise;
  }

  #enqueue<T extends InternalOperationResult>(
    kind: RecoveryOperationKind,
    scopeId: string,
    charge: MeasuredRecoveryCharge,
    execute: () => Promise<T>,
  ): Promise<T | RecoveryOperationFailure> {
    if (this.#disposed) return Promise.resolve({ kind: "disposed" });
    if (!this.#backendAvailable) {
      return Promise.resolve({ kind: "backend-unavailable" });
    }
    const ownerId = `${this.#databaseName}:${kind}:${String(this.#nextOperationId)}`;
    const resourceCharge: RecoveryResourceCharge = {
      ...charge,
      ownerId,
      scopeId,
    };
    const reservation = admitRecoveryQueueOperation(
      this.#resources,
      resourceCharge,
    );
    if (reservation === null) {
      return Promise.resolve({ kind: "resource-limited" });
    }
    this.#nextOperationId += 1;
    const result = new Promise<
      InternalOperationResult | RecoveryOperationFailure
    >((resolve) => {
      this.#queue.push({
        execute,
        kind,
        ownerId,
        reservation,
        resolve,
      });
    });
    this.#drain();
    return result as Promise<T | RecoveryOperationFailure>;
  }

  #drain(): void {
    if (this.#active !== undefined || this.#disposed) return;
    const pending = this.#queue.shift();
    if (pending === undefined) {
      this.#finishDisposalIfIdle();
      return;
    }
    this.#active = pending;
    void this.#executePending(pending);
  }

  async #executePending(pending: PendingOperation): Promise<void> {
    let result: InternalOperationResult | RecoveryOperationFailure;
    try {
      await this.#faultInjector?.beforeExecute?.(pending.kind);
      if (this.#disposed) {
        result = { kind: "disposed" };
      } else if (!this.#backendAvailable) {
        result = { kind: "backend-unavailable" };
      } else if (!pending.reservation.activate()) {
        result = { kind: "resource-limited" };
      } else {
        result = await pending.execute();
      }
    } catch (error) {
      result = mapIndexedDbFailure(error);
    }
    let terminal = result;
    if (this.#disposed) terminal = { kind: "disposed" };
    else if (!this.#backendAvailable) {
      terminal = { kind: "backend-unavailable" };
    }
    this.#settlePending(pending, terminal);
  }

  #settlePending(
    pending: PendingOperation,
    result: InternalOperationResult | RecoveryOperationFailure,
  ): void {
    const resultKind = "kind" in result ? result.kind : undefined;
    const release = completeRecoveryReservation(
      pending.reservation,
      pending.ownerId,
      resultKind === "loaded",
    );
    const publicResult =
      resultKind === "loaded" && release !== null
        ? { ...result, releaseResources: release }
        : result;
    pending.resolve(publicResult);
    this.#active = undefined;
    if (this.#disposed) this.#finishDisposalIfIdle();
    else this.#drain();
  }

  #cancelQueued(failure: RecoveryOperationFailure): void {
    for (const pending of this.#queue.splice(0)) {
      pending.reservation.release();
      pending.resolve(failure);
    }
  }

  #handleVersionChange(): void {
    if (!this.#backendAvailable) return;
    this.#backendAvailable = false;
    this.#removeVersionListener();
    this.#database.close();
    this.#transactions.abort();
    this.#cancelQueued({ kind: "backend-unavailable" });
  }

  #removeVersionListener(): void {
    this.#database.removeEventListener(
      "versionchange",
      this.#versionChangeHandler,
    );
    this.#listenerHandle.release();
  }

  #finishDisposalIfIdle(): void {
    if (!this.#disposed || this.#active !== undefined) return;
    this.#removeVersionListener();
    this.#database.close();
    this.#resolveDisposal?.();
    this.#resolveDisposal = undefined;
  }
}

function invalidResult<T>(): Promise<T | RecoveryOperationFailure> {
  return Promise.resolve({ kind: "invalid-input" });
}
