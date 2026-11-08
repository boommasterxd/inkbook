import { FRAME_WORK_SHARE, type WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import {
  createDocumentRuntime,
  DocumentWorkerRuntime,
  GestureAwareSliceScheduler,
  type DocumentRuntimePort,
} from "../../../persistence/worker/runtime/public";
import type { SafeStaticProof } from "../../../persistence/serialization/input/safe-static-proof";
import { prepareExportGeometry } from "../../../persistence/export/export-geometry";
import type { PreparedExportCuts } from "../../../domain/export/export-pagination";

/** One temporary executor is reused for this render, then released before printing. */
export class ExportGeometrySession {
  readonly #ownerWindow: Window | null;
  readonly #scheduler: WorkScheduler;
  readonly #signal: AbortSignal;
  readonly #subscribeSchedulingProfile: ((listener: () => void) => () => void) | undefined;
  #sessionId = "";
  #runtime: DocumentRuntimePort | undefined;
  #epoch = 1;
  #operation = 0;
  #fallback = false;
  #disposed = false;

  constructor(
    ownerWindow: Window | null,
    scheduler: WorkScheduler,
    signal: AbortSignal,
    subscribeSchedulingProfile?: (listener: () => void) => () => void,
  ) {
    this.#ownerWindow = ownerWindow;
    this.#scheduler = scheduler;
    this.#signal = signal;
    this.#subscribeSchedulingProfile = subscribeSchedulingProfile;
    signal.addEventListener("abort", this.#terminate, { once: true });
  }

  async prepare(
    input: string,
    safeStaticProof?: SafeStaticProof,
  ): Promise<PreparedExportCuts | undefined> {
    this.#signal.throwIfAborted();
    try {
      if (this.#runtime === undefined) await this.#createRuntime();
      return await this.#prepare(input, safeStaticProof);
    } catch {
      this.#signal.throwIfAborted();
      if (this.#fallback || this.#disposed) return undefined;
      this.#createFallback();
      try {
        return await this.#prepare(input, safeStaticProof);
      } catch {
        this.#signal.throwIfAborted();
        return undefined;
      }
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#signal.removeEventListener("abort", this.#terminate);
    this.#terminate();
  }

  readonly #terminate = (): void => {
    this.#runtime?.terminate();
    this.#runtime = undefined;
  };

  async #createRuntime(): Promise<void> {
    this.#sessionId ||= `inkbook-print-${crypto.randomUUID()}`;
    if (this.#ownerWindow === null) return this.#createFallback();
    try {
      const runtime = await createDocumentRuntime(this.#sessionId, this.#epoch, this.#ownerWindow, {
        workScheduler: this.#scheduler,
        frameIntervalMilliseconds: () => this.#scheduler.budgetMs() / FRAME_WORK_SHARE,
        ...(this.#subscribeSchedulingProfile === undefined
          ? {}
          : { subscribeSchedulingProfile: this.#subscribeSchedulingProfile }),
      });
      if (this.#disposed || this.#signal.aborted) {
        runtime.terminate();
        this.#signal.throwIfAborted();
        throw new Error("The print geometry owner was disposed.");
      }
      this.#runtime = runtime;
    } catch {
      this.#signal.throwIfAborted();
      if (!this.#disposed) this.#createFallback();
    }
  }

  #createFallback(): void {
    this.#terminate();
    this.#fallback = true;
    this.#epoch += 1;
    this.#runtime = new DocumentWorkerRuntime(
      { sessionId: this.#sessionId, workerEpoch: this.#epoch },
      new GestureAwareSliceScheduler({
        isInputActive: () => false,
        workScheduler: this.#scheduler,
      }),
    );
  }

  #prepare(
    input: string,
    safeStaticProof?: SafeStaticProof,
  ): Promise<PreparedExportCuts | undefined> {
    if (this.#runtime === undefined) throw new Error("The print executor is unavailable.");
    return prepareExportGeometry(input, {
      runtime: this.#runtime,
      identity: {
        sessionId: this.#sessionId,
        workerEpoch: this.#epoch,
        operationId: ++this.#operation,
        purpose: "preflight",
      },
      workScheduler: this.#scheduler,
      signal: this.#signal,
      ...(safeStaticProof === undefined ? {} : { safeStaticProof }),
    });
  }
}
