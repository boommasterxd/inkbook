import type {
  CommandResultV1,
  RecoveryAttemptId,
} from "../../application/note-session";
import {
  RECOVERY_STORE_LIMITS_V1,
  type HostAcknowledgementV1,
  type HostRecordedDirectionAttemptV1,
  type PreparedForwardAttemptV1,
  type RecoveryLoadRequestV1,
  type RecoveryPersistenceRecordV1,
  type RecoveryRekeyV1,
  type RecoverySagaCompletionV1,
  type RecoverySnapshotV1,
  type RecoveryStore,
  type RelocationRecordV1,
  type RelocationTransitionV1,
  type RemovalRecordV1,
  type RemovalTransitionV1,
  type SidecarRecoveryAcknowledgementV1,
} from "../../application/recovery";
import type { SourceCheckpointOperationV1 } from "../../application/source-coordination";
import { acknowledgeSidecar } from "./acknowledgement";
import { loadNote } from "./load";
import {
  admitQueueRequest,
  admitRecoveryRecord,
  admitRecoveryTransition,
  type AdmittedRecoveryTransition,
} from "./queue-admission";
import { rekeyNote } from "./rekey";
import type {
  IndexedDbRecoveryLimits,
  IndexedDbRecoveryOptions,
} from "./types";
import {
  appendDirection,
  appendSourceCheckpoint,
  beginRelocation,
  beginRemoval,
  completeSaga,
  prepareForward,
  recordForward,
  advanceRelocation,
  advanceRemoval,
  type WriteContext,
} from "./write-operations";

const DEFAULT_MAX_QUEUED_OPERATIONS = 64;
const DEFAULT_MAX_QUEUED_BYTES = RECOVERY_STORE_LIMITS_V1.maxGlobalBytes;
const MAXIMUM_LIMITS: IndexedDbRecoveryLimits = Object.freeze({
  directSuccessors: RECOVERY_STORE_LIMITS_V1.maxDirectSuccessorsPerBase,
  globalBytes: RECOVERY_STORE_LIMITS_V1.maxGlobalBytes,
  globalRecords: RECOVERY_STORE_LIMITS_V1.maxGlobalRecords,
  noteBytes: RECOVERY_STORE_LIMITS_V1.maxNoteBytes,
  noteRecords: RECOVERY_STORE_LIMITS_V1.maxNoteRecords,
  queuedBytes: DEFAULT_MAX_QUEUED_BYTES,
  queuedOperations: DEFAULT_MAX_QUEUED_OPERATIONS,
});

export class IndexedDbRecoveryStore implements RecoveryStore {
  readonly #context: WriteContext;
  readonly #onVersionChange: () => void;
  #disposed = false;
  #outstandingBytes = 0;
  #outstandingOperations = 0;
  #tail: Promise<void> = Promise.resolve();

  public constructor(database: IDBDatabase, options: IndexedDbRecoveryOptions) {
    this.#context = {
      database,
      faultInjector: options.faultInjector,
      limits: resolveLimits(options.limits),
    };
    this.#onVersionChange = (): void => database.close();
    database.addEventListener("versionchange", this.#onVersionChange);
  }

  public prepareForward(
    attempt: PreparedForwardAttemptV1,
  ): Promise<CommandResultV1<void>> {
    return this.#enqueueRecord(attempt, (record, bytes) =>
      prepareForward(this.#context, record, bytes),
    );
  }

  public recordForward(
    attemptId: RecoveryAttemptId,
    acknowledgement: HostAcknowledgementV1,
  ): Promise<CommandResultV1<void>> {
    return this.#enqueueRequest({ acknowledgement, attemptId }, (request) =>
      recordForward(this.#context, request.attemptId, request.acknowledgement),
    );
  }

  public appendDirection(
    attempt: HostRecordedDirectionAttemptV1,
  ): Promise<CommandResultV1<void>> {
    return this.#enqueueRecord(attempt, (record, bytes) =>
      appendDirection(this.#context, record, bytes),
    );
  }

  public appendSourceCheckpoint(
    checkpoint: SourceCheckpointOperationV1,
  ): Promise<CommandResultV1<void>> {
    return this.#enqueueRecord(checkpoint, (record, bytes) =>
      appendSourceCheckpoint(this.#context, record, bytes),
    );
  }

  public acknowledgeSidecar(
    request: SidecarRecoveryAcknowledgementV1,
  ): Promise<CommandResultV1<void>> {
    return this.#enqueueRequest(request, (admitted) =>
      acknowledgeSidecar(this.#context, admitted),
    );
  }

  public beginRelocation(
    record: RelocationRecordV1,
  ): Promise<CommandResultV1<void>> {
    return this.#enqueueRecord(record, (admitted, bytes) =>
      beginRelocation(this.#context, admitted, bytes),
    );
  }

  public advanceRelocation(
    request: RelocationTransitionV1,
  ): Promise<CommandResultV1<void>> {
    return this.#enqueueTransition(request, (admitted) =>
      advanceRelocation(
        this.#context,
        admitted.transition,
        admitted.expectedBytes,
        admitted.replacementBytes,
      ),
    );
  }

  public beginRemoval(record: RemovalRecordV1): Promise<CommandResultV1<void>> {
    return this.#enqueueRecord(record, (admitted, bytes) =>
      beginRemoval(this.#context, admitted, bytes),
    );
  }

  public advanceRemoval(
    request: RemovalTransitionV1,
  ): Promise<CommandResultV1<void>> {
    return this.#enqueueTransition(request, (admitted) =>
      advanceRemoval(
        this.#context,
        admitted.transition,
        admitted.expectedBytes,
        admitted.replacementBytes,
      ),
    );
  }

  public completeSaga(
    request: RecoverySagaCompletionV1,
  ): Promise<CommandResultV1<void>> {
    return this.#enqueueRequest(request, (admitted) =>
      completeSaga(this.#context, admitted),
    );
  }

  public rekeyNote(request: RecoveryRekeyV1): Promise<CommandResultV1<void>> {
    return this.#enqueueRequest(request, (admitted) =>
      rekeyNote(this.#context, admitted),
    );
  }

  public loadNote(
    request: RecoveryLoadRequestV1,
  ): Promise<CommandResultV1<RecoverySnapshotV1>> {
    return this.#enqueueRequest(request, (admitted) =>
      loadNote(this.#context.database, this.#context.limits, admitted),
    );
  }

  public async dispose(): Promise<void> {
    if (!this.#disposed) {
      this.#disposed = true;
      await this.#tail;
      this.#context.database.removeEventListener(
        "versionchange",
        this.#onVersionChange,
      );
      this.#context.database.close();
      return;
    }
    await this.#tail;
  }

  #enqueueRecord<T extends RecoveryPersistenceRecordV1, R>(
    record: T,
    work: (record: T, bytes: Uint8Array) => Promise<CommandResultV1<R>>,
  ): Promise<CommandResultV1<R>> {
    const admitted = admitRecoveryRecord(record);
    if (!admitted.ok) return Promise.resolve(admitted);
    return this.#enqueue(admitted.value.bytes.byteLength, () =>
      work(admitted.value.record, admitted.value.bytes),
    );
  }

  #enqueueRequest<T, R>(
    request: T,
    work: (request: T) => Promise<CommandResultV1<R>>,
  ): Promise<CommandResultV1<R>> {
    const admitted = admitQueueRequest(request);
    if (!admitted.ok) return Promise.resolve(admitted);
    return this.#enqueue(admitted.value.byteSize, () =>
      work(admitted.value.value),
    );
  }

  #enqueueTransition<
    TExpected extends RecoveryPersistenceRecordV1,
    TReplacement extends RecoveryPersistenceRecordV1,
    R,
  >(
    request: Readonly<{ expected: TExpected; replacement: TReplacement }>,
    work: (
      admitted: AdmittedRecoveryTransition<TExpected, TReplacement>,
    ) => Promise<CommandResultV1<R>>,
  ): Promise<CommandResultV1<R>> {
    const admitted = admitRecoveryTransition(request);
    if (!admitted.ok) return Promise.resolve(admitted);
    return this.#enqueue(admitted.value.byteSize, () => work(admitted.value));
  }

  #enqueue<T>(
    retainedBytes: number,
    work: () => Promise<CommandResultV1<T>>,
  ): Promise<CommandResultV1<T>> {
    if (this.#disposed) return Promise.resolve(disposed());
    if (
      this.#outstandingOperations >= this.#context.limits.queuedOperations ||
      retainedBytes > this.#context.limits.queuedBytes - this.#outstandingBytes
    ) {
      return Promise.resolve({ ok: false, code: "recovery-limit" });
    }
    this.#outstandingBytes += retainedBytes;
    this.#outstandingOperations += 1;
    const result = this.#tail.then<CommandResultV1<T>>(async () => {
      if (this.#disposed) return disposed<T>();
      return work();
    });
    const settled = result.finally(() => {
      this.#outstandingBytes -= retainedBytes;
      this.#outstandingOperations -= 1;
    });
    this.#tail = settled.then(
      () => undefined,
      () => undefined,
    );
    return settled;
  }
}

function resolveLimits(
  overrides: Partial<IndexedDbRecoveryLimits> | undefined,
): IndexedDbRecoveryLimits {
  const limits = {
    directSuccessors:
      overrides?.directSuccessors ??
      RECOVERY_STORE_LIMITS_V1.maxDirectSuccessorsPerBase,
    globalBytes:
      overrides?.globalBytes ?? RECOVERY_STORE_LIMITS_V1.maxGlobalBytes,
    globalRecords:
      overrides?.globalRecords ?? RECOVERY_STORE_LIMITS_V1.maxGlobalRecords,
    noteBytes: overrides?.noteBytes ?? RECOVERY_STORE_LIMITS_V1.maxNoteBytes,
    noteRecords:
      overrides?.noteRecords ?? RECOVERY_STORE_LIMITS_V1.maxNoteRecords,
    queuedBytes: overrides?.queuedBytes ?? DEFAULT_MAX_QUEUED_BYTES,
    queuedOperations:
      overrides?.queuedOperations ?? DEFAULT_MAX_QUEUED_OPERATIONS,
  };
  const configured = Object.entries(limits) as readonly [
    keyof IndexedDbRecoveryLimits,
    number,
  ][];
  if (
    configured.some(([key, value]) => !validLimit(value, MAXIMUM_LIMITS[key]))
  ) {
    throw new RangeError(
      "Recovery store limits must be positive safe integers at or below product maxima.",
    );
  }
  return limits;
}

function validLimit(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function disposed<T>(): CommandResultV1<T> {
  return { ok: false, code: "disposed" };
}
