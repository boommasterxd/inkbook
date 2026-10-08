import type {
  ClipboardCandidates,
  ClipboardWritePayload,
  PasteInvocation,
  PastePlan,
  PasteRepeatState,
} from "../../persistence/clipboard/public";
import type { PurposeOperationIdentity } from "../../persistence/worker/protocol";
import type {
  DocumentRuntimePort,
  DocumentRuntimeRequest,
  DocumentRuntimeResult,
} from "../../persistence/worker/runtime/public";

interface SessionClipboardOptions {
  readonly disposed: () => boolean;
  readonly executor: () => DocumentRuntimePort | undefined;
  readonly recoverExecutorFailure: () => boolean | Promise<boolean>;
  readonly synchronizeWorkerBaseline: (identity: PurposeOperationIdentity) => Promise<boolean>;
  readonly now: () => number;
  readonly revision: () => number;
  readonly sessionId: string;
  readonly workerEpoch: () => number;
}

export class SessionClipboardCoordinator {
  #operationId = 0;
  readonly #options: SessionClipboardOptions;

  constructor(options: SessionClipboardOptions) {
    this.#options = options;
  }

  async encode(selectedIds: ReadonlySet<string>): Promise<ClipboardWritePayload | null> {
    if (selectedIds.size === 0) return null;
    return this.#execute(
      (basisRevision, identity) => ({
        basisRevision,
        identity,
        selectedIds: [...selectedIds],
        type: "clipboard-encode",
      }),
      (result, identity, basisRevision) =>
        result.type === "clipboard-encode-success" &&
        this.#isCurrent(result.identity, identity, basisRevision) &&
        result.result.ok
          ? result.result.value
          : null,
    );
  }

  async planPaste(
    candidates: ClipboardCandidates,
    invocation: PasteInvocation,
    previousRepeat?: PasteRepeatState,
  ): Promise<PastePlan | null> {
    return this.#execute(
      (basisRevision, identity) => ({
        basisRevision,
        candidates,
        commandTimestamp: this.#options.now(),
        identity,
        invocation,
        ...(previousRepeat === undefined ? {} : { previousRepeat }),
        type: "clipboard-plan-paste",
      }),
      (result, identity, basisRevision) =>
        result.type === "clipboard-plan-paste-success" &&
        this.#isCurrent(result.identity, identity, basisRevision) &&
        result.result.ok
          ? result.result.value
          : null,
    );
  }

  async #execute<Result>(
    request: (basisRevision: number, identity: PurposeOperationIdentity) => DocumentRuntimeRequest,
    accept: (
      result: DocumentRuntimeResult,
      identity: PurposeOperationIdentity,
      basisRevision: number,
    ) => Result | null,
  ): Promise<Result | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const executor = this.#options.executor();
      if (executor === undefined) return null;
      const identity = this.#nextIdentity();
      if (!(await this.#options.synchronizeWorkerBaseline(identity))) {
        if (attempt === 0 && this.#options.workerEpoch() !== identity.workerEpoch) continue;
        return null;
      }
      const basisRevision = this.#options.revision();
      try {
        return accept(
          await executor.execute(request(basisRevision, identity)),
          identity,
          basisRevision,
        );
      } catch {
        if (attempt === 0 && (await this.#options.recoverExecutorFailure())) continue;
        return null;
      }
    }
    return null;
  }

  #nextIdentity(): PurposeOperationIdentity {
    this.#operationId += 1;
    if (!Number.isSafeInteger(this.#operationId)) {
      throw new RangeError("clipboardOperationId reached Number.MAX_SAFE_INTEGER.");
    }
    return {
      operationId: this.#operationId,
      purpose: "clipboard",
      sessionId: this.#options.sessionId,
      workerEpoch: this.#options.workerEpoch(),
    };
  }

  #isCurrent(
    result: PurposeOperationIdentity,
    expected: PurposeOperationIdentity,
    basisRevision: number,
  ): boolean {
    return (
      result.operationId === expected.operationId &&
      result.sessionId === expected.sessionId &&
      result.workerEpoch === expected.workerEpoch &&
      this.#options.workerEpoch() === expected.workerEpoch &&
      this.#options.revision() === basisRevision &&
      !this.#options.disposed()
    );
  }
}
