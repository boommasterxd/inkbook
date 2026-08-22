import type {
  ExecutorIdentity,
  ExportIdentity,
  OperationId,
  PurposeOperationIdentity,
  SessionId,
  WorkerEpoch,
  WorkerPurpose,
} from "./protocol";

const assertSafeCounter = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
};

const nextSafeCounter = (value: number, name: string): number => {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${name} reached Number.MAX_SAFE_INTEGER.`);
  }

  return value + 1;
};

export const isCurrentExecutor = (
  current: ExecutorIdentity,
  candidate: ExecutorIdentity,
): boolean =>
  current.sessionId === candidate.sessionId && current.workerEpoch === candidate.workerEpoch;

export const isCurrentExport = (
  current: ExecutorIdentity,
  newestExportGeneration: number,
  candidate: ExportIdentity,
): boolean =>
  isCurrentExecutor(current, candidate) && candidate.exportGeneration === newestExportGeneration;

export class PurposeIdentityRegistry {
  readonly #sessionId: SessionId;
  #workerEpoch: WorkerEpoch;
  readonly #nextByPurpose = new Map<WorkerPurpose, OperationId>();
  readonly #currentByPurpose = new Map<WorkerPurpose, OperationId>();

  public constructor(sessionId: SessionId, workerEpoch = 0) {
    if (sessionId.length === 0) {
      throw new RangeError("sessionId must not be empty.");
    }
    assertSafeCounter(workerEpoch, "workerEpoch");
    this.#sessionId = sessionId;
    this.#workerEpoch = workerEpoch;
  }

  public get executor(): ExecutorIdentity {
    return { sessionId: this.#sessionId, workerEpoch: this.#workerEpoch };
  }

  public begin(purpose: WorkerPurpose): PurposeOperationIdentity {
    const operationId = nextSafeCounter(this.#nextByPurpose.get(purpose) ?? 0, "operationId");
    this.#nextByPurpose.set(purpose, operationId);
    this.#currentByPurpose.set(purpose, operationId);
    return { ...this.executor, operationId, purpose };
  }

  public finish(candidate: PurposeOperationIdentity): boolean {
    if (!this.isCurrent(candidate)) {
      return false;
    }
    this.#currentByPurpose.delete(candidate.purpose);
    return true;
  }

  public invalidateExecutor(): ExecutorIdentity {
    this.#workerEpoch = nextSafeCounter(this.#workerEpoch, "workerEpoch");
    this.#currentByPurpose.clear();
    return this.executor;
  }

  public isCurrent(candidate: PurposeOperationIdentity): boolean {
    return (
      isCurrentExecutor(this.executor, candidate) &&
      this.#currentByPurpose.get(candidate.purpose) === candidate.operationId
    );
  }
}

export { assertSafeCounter, nextSafeCounter };
