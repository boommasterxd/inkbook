import type {
  CommandResultV1,
  RecoveryAttemptId,
} from "../../application/note-session";
import {
  type ActiveRemovalRecoveryV1,
  type BeginPrefixRelocationBatchV1,
  type FinalizeRemovalRecoveryV1,
  type HostAcknowledgementV1,
  type HostRecordedDirectionAttemptV1,
  type HostRecordedForwardAttemptV1,
  type LoadRelocationByIdV1,
  type LoadActiveRemovalV1,
  type LoadPrefixRelocationMemberV1,
  type LoadActivePrefixRelocationsV1,
  type LoadRetainedPrefixRelocationRulesV1,
  type PrefixRelocationMemberV1,
  type PrefixRelocationPlanV1,
  type PrefixRelocationRecordV1,
  type PreparePrefixRelocationPlanV1,
  type DiscardConfirmedNoteRecoveryV1,
  type PreparedForwardAttemptV1,
  type RecoveryLoadRequestV1,
  type RecoveryPersistenceRecordV1,
  type RecoveryRekeyV1,
  type RecoverySagaCompletionV1,
  type RecoverySnapshotV1,
  type RecoveryStore,
  type RemoveRetainedPrefixRelocationRuleForMaintenanceV1,
  type RelocationRecordV1,
  type RelocationTransitionV1,
  type RemovalRecordV1,
  type RemovalTransitionV1,
  type SidecarRecoveryAcknowledgementV1,
} from "../../application/recovery";
import type { SourceCheckpointOperationV1 } from "../../application/source-coordination";
import { acknowledgeSidecar } from "./acknowledgement";
import {
  discardConfirmedNoteRecovery,
  prepareRecoveryDiscard,
} from "./discard";
import { loadNote } from "./load";
import { admitRelocationLoad, loadRelocationById } from "./relocation-load";
import {
  admitPrefixRelocationPlan,
  loadActivePrefixRelocations,
  loadPrefixRelocationMember,
  preparePrefixRelocationPlan,
} from "./prefix-plan";
import {
  admitQueueRequest,
  admitRecoveryRecord,
  admitRecoveryTransition,
  type AdmittedRecoveryTransition,
} from "./queue-admission";
import { rekeyNote } from "./rekey";
import {
  admitActiveRemovalLoad,
  finalizeRemovalRecovery,
  loadActiveRemoval,
  prepareRemovalFinalization,
} from "./removal-recovery";
import { resolveRecoveryStoreLimits } from "./store-limits";
import {
  admitPrefixRelocationBatch,
  admitRetainedRuleLoad,
  admitRetainedRuleRemoval,
  beginPrefixRelocationBatch,
  hasPrefixRelocationKind,
  loadRetainedPrefixRelocationRules,
  removeRetainedPrefixRelocationRuleForMaintenance,
} from "./retained-prefix-rules";
import type { IndexedDbRecoveryOptions } from "./types";
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

const MINIMUM_QUEUE_FOR_COMPLETION_RESERVE = 8;
const COMPLETION_OPERATION_RESERVE = 4;
const COMPLETION_BYTE_RESERVE_DIVISOR = 8;

export class IndexedDbRecoveryStore implements RecoveryStore {
  readonly #context: WriteContext;
  readonly #onVersionChange: () => void;
  #closing = false;
  #disposePromise: Promise<void> | null = null;
  #outstandingBytes = 0;
  #outstandingOperations = 0;
  #ordinaryOutstandingBytes = 0;
  #ordinaryOutstandingOperations = 0;
  #tail: Promise<void> = Promise.resolve();

  public constructor(database: IDBDatabase, options: IndexedDbRecoveryOptions) {
    this.#context = {
      database,
      faultInjector: options.faultInjector,
      limits: resolveRecoveryStoreLimits(options.limits),
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
  ): Promise<CommandResultV1<HostRecordedForwardAttemptV1>> {
    return this.#enqueueRequest(
      { acknowledgement, attemptId },
      (request) =>
        recordForward(
          this.#context,
          request.attemptId,
          request.acknowledgement,
        ),
      true,
    );
  }

  public appendDirection(
    attempt: HostRecordedDirectionAttemptV1,
  ): Promise<CommandResultV1<HostRecordedDirectionAttemptV1>> {
    return this.#enqueueRecord(attempt, async (record, bytes) => {
      const result = await appendDirection(this.#context, record, bytes);
      return result.ok ? { ok: true, value: record } : result;
    });
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
    return this.#enqueueRequest(
      request,
      (admitted) => acknowledgeSidecar(this.#context, admitted),
      true,
    );
  }

  public beginRelocation(
    record: RelocationRecordV1,
  ): Promise<CommandResultV1<void>> {
    if (hasPrefixRelocationKind(record)) {
      return this.beginPrefixRelocationBatch({ records: [record] });
    }
    return this.#enqueueRecord(record, (admitted, bytes) =>
      beginRelocation(this.#context, admitted, bytes),
    );
  }

  public beginPrefixRelocationBatch(
    request: BeginPrefixRelocationBatchV1,
  ): Promise<CommandResultV1<void>> {
    const admitted = admitPrefixRelocationBatch(request);
    if (!admitted.ok) return Promise.resolve(admitted);
    return this.#enqueue(admitted.value.retainedBytes, () =>
      beginPrefixRelocationBatch(this.#context, admitted.value),
    );
  }

  public advanceRelocation(
    request: RelocationTransitionV1,
  ): Promise<CommandResultV1<void>> {
    return this.#enqueueTransition(
      request,
      (admitted) =>
        advanceRelocation(
          this.#context,
          admitted.transition,
          admitted.expectedBytes,
          admitted.replacementBytes,
        ),
      true,
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
    return this.#enqueueTransition(
      request,
      (admitted) =>
        advanceRemoval(
          this.#context,
          admitted.transition,
          admitted.expectedBytes,
          admitted.replacementBytes,
        ),
      true,
    );
  }

  public completeSaga(
    request: RecoverySagaCompletionV1,
  ): Promise<CommandResultV1<void>> {
    return this.#enqueueRequest(
      request,
      (admitted) => completeSaga(this.#context, admitted),
      true,
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

  public discardConfirmedNoteRecovery(
    request: DiscardConfirmedNoteRecoveryV1,
  ): Promise<CommandResultV1<void>> {
    const prepared = prepareRecoveryDiscard(request, this.#context);
    if (!prepared.ok) return Promise.resolve(prepared);
    return this.#enqueue(
      prepared.value.retainedBytes,
      () => discardConfirmedNoteRecovery(this.#context, prepared.value),
      true,
    );
  }

  public finalizeRemovalRecovery(
    request: FinalizeRemovalRecoveryV1,
  ): Promise<CommandResultV1<void>> {
    const prepared = prepareRemovalFinalization(request, this.#context);
    if (!prepared.ok) return Promise.resolve(prepared);
    return this.#enqueue(
      prepared.value.retainedBytes,
      () => finalizeRemovalRecovery(this.#context, prepared.value),
      true,
    );
  }

  public loadActiveRemoval(
    request: LoadActiveRemovalV1,
  ): Promise<CommandResultV1<ActiveRemovalRecoveryV1 | null>> {
    const admitted = admitActiveRemovalLoad(request);
    if (!admitted.ok) return Promise.resolve(admitted);
    return this.#enqueue(
      admitted.value.byteSize,
      () => loadActiveRemoval(this.#context, admitted.value.value),
      true,
    );
  }

  public preparePrefixRelocationPlan(
    request: PreparePrefixRelocationPlanV1,
  ): Promise<CommandResultV1<PrefixRelocationPlanV1>> {
    const admitted = admitPrefixRelocationPlan(request);
    if (!admitted.ok) return Promise.resolve(admitted);
    return this.#enqueue(
      admitted.value.retainedBytes,
      () => preparePrefixRelocationPlan(this.#context, admitted.value),
      true,
    );
  }

  public loadPrefixRelocationMember(
    request: LoadPrefixRelocationMemberV1,
  ): Promise<CommandResultV1<PrefixRelocationMemberV1>> {
    return this.#enqueueRequest(
      request,
      (admitted) =>
        loadPrefixRelocationMember(this.#context.database, admitted),
      true,
    );
  }

  public loadRelocationById(
    request: LoadRelocationByIdV1,
  ): Promise<CommandResultV1<RelocationRecordV1 | null>> {
    const admitted = admitRelocationLoad(request);
    if (!admitted.ok) return Promise.resolve(admitted);
    return this.#enqueue(
      admitted.value.byteSize,
      () => loadRelocationById(this.#context.database, admitted.value.value),
      true,
    );
  }

  public loadActivePrefixRelocations(
    request: LoadActivePrefixRelocationsV1,
  ): Promise<CommandResultV1<readonly PrefixRelocationRecordV1[]>> {
    return this.#enqueueRequest(
      request,
      (admitted) =>
        loadActivePrefixRelocations(this.#context.database, admitted),
      true,
    );
  }

  public loadRetainedPrefixRelocationRules(
    request: LoadRetainedPrefixRelocationRulesV1,
  ): Promise<CommandResultV1<readonly PrefixRelocationRecordV1[]>> {
    const admitted = admitRetainedRuleLoad(request);
    if (!admitted.ok) return Promise.resolve(admitted);
    return this.#enqueue(
      admitted.value.byteSize,
      () =>
        loadRetainedPrefixRelocationRules(
          this.#context.database,
          admitted.value.value,
        ),
      true,
    );
  }

  public removeRetainedPrefixRelocationRuleForMaintenance(
    request: RemoveRetainedPrefixRelocationRuleForMaintenanceV1,
  ): Promise<CommandResultV1<void>> {
    const admitted = admitRetainedRuleRemoval(request);
    if (!admitted.ok) return Promise.resolve(admitted);
    return this.#enqueue(
      admitted.value.byteSize,
      () =>
        removeRetainedPrefixRelocationRuleForMaintenance(
          this.#context,
          admitted.value,
        ),
      true,
    );
  }

  public async dispose(): Promise<void> {
    if (this.#disposePromise !== null) return this.#disposePromise;
    this.#closing = true;
    this.#disposePromise = this.#tail.then(() => {
      this.#context.database.removeEventListener(
        "versionchange",
        this.#onVersionChange,
      );
      this.#context.database.close();
    });
    return this.#disposePromise;
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
    critical = false,
  ): Promise<CommandResultV1<R>> {
    const admitted = admitQueueRequest(request);
    if (!admitted.ok) return Promise.resolve(admitted);
    return this.#enqueue(
      admitted.value.byteSize,
      () => work(admitted.value.value),
      critical,
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
    critical = false,
  ): Promise<CommandResultV1<R>> {
    const admitted = admitRecoveryTransition(request);
    if (!admitted.ok) return Promise.resolve(admitted);
    return this.#enqueue(
      admitted.value.byteSize,
      () => work(admitted.value),
      critical,
    );
  }

  #enqueue<T>(
    retainedBytes: number,
    work: () => Promise<CommandResultV1<T>>,
    critical = false,
  ): Promise<CommandResultV1<T>> {
    if (this.#closing) return Promise.resolve(disposed());
    if (!this.#hasQueueCapacity(retainedBytes, critical)) {
      return Promise.resolve({ ok: false, code: "recovery-limit" });
    }
    this.#outstandingBytes += retainedBytes;
    this.#outstandingOperations += 1;
    if (!critical) {
      this.#ordinaryOutstandingBytes += retainedBytes;
      this.#ordinaryOutstandingOperations += 1;
    }
    const result = this.#tail.then<CommandResultV1<T>>(async () => {
      if (this.#closing && !critical) return disposed<T>();
      return work();
    });
    const settled = result.finally(() => {
      this.#outstandingBytes -= retainedBytes;
      this.#outstandingOperations -= 1;
      if (!critical) {
        this.#ordinaryOutstandingBytes -= retainedBytes;
        this.#ordinaryOutstandingOperations -= 1;
      }
    });
    this.#tail = settled.then(
      () => undefined,
      () => undefined,
    );
    return settled;
  }

  #hasQueueCapacity(retainedBytes: number, critical: boolean): boolean {
    const limits = this.#context.limits;
    if (
      this.#outstandingOperations >= limits.queuedOperations ||
      retainedBytes > limits.queuedBytes - this.#outstandingBytes
    ) {
      return false;
    }
    if (
      critical ||
      limits.queuedOperations < MINIMUM_QUEUE_FOR_COMPLETION_RESERVE
    ) {
      return true;
    }
    const ordinaryOperationLimit =
      limits.queuedOperations - COMPLETION_OPERATION_RESERVE;
    const reservedBytes = Math.floor(
      limits.queuedBytes / COMPLETION_BYTE_RESERVE_DIVISOR,
    );
    return (
      this.#ordinaryOutstandingOperations < ordinaryOperationLimit &&
      retainedBytes <=
        limits.queuedBytes - reservedBytes - this.#ordinaryOutstandingBytes
    );
  }
}

function disposed<T>(): CommandResultV1<T> {
  return { ok: false, code: "disposed" };
}
