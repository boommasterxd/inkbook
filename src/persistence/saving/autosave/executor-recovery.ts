import type { DocumentRuntimePort } from "../../worker/runtime/public";
import type { AutosaveCoordinatorOptions } from "./types";
import { isAutosaveSuspended } from "./status";
import type { AutosaveStatus } from "./types";
import { nextSafeCounter } from "../../worker/identity";

/** Coalesces concurrent failures without allocating parallel replacement executors. */
export class AutosaveExecutorRecovery {
  #pending: Promise<boolean> | undefined;
  #fallbackUsed = false;
  #executor: DocumentRuntimePort;
  #epoch: number;

  constructor(
    private readonly factories: Pick<
      AutosaveCoordinatorOptions,
      "createFallback" | "createReplacement" | "executor" | "workerEpoch"
    >,
  ) {
    this.#executor = factories.executor;
    this.#epoch = factories.workerEpoch ?? 0;
  }

  get executor(): DocumentRuntimePort {
    return this.#executor;
  }
  get epoch(): number {
    return this.#epoch;
  }

  get pending(): boolean {
    return this.#pending !== undefined;
  }

  blocksSynchronization(disposed: boolean, status: AutosaveStatus): boolean {
    return disposed || this.pending || isAutosaveSuspended(status);
  }

  recover(options: {
    readonly disposed: () => boolean;
    readonly adopt: () => void;
    readonly failed?: () => void;
  }): Promise<boolean> {
    if (this.#pending !== undefined) return this.#pending;
    const create = this.factories.createReplacement ?? this.takeFallback();
    if (options.disposed()) return Promise.resolve(false);
    if (create === undefined) {
      options.failed?.();
      return Promise.resolve(false);
    }
    this.#executor.terminate();
    const epoch = nextSafeCounter(this.#epoch, "workerEpoch");
    this.#pending = Promise.resolve()
      .then(() => {
        if (options.disposed()) throw new Error("The autosave coordinator has been disposed.");
        return create(epoch);
      })
      .then(
        (executor) => {
          if (options.disposed()) {
            executor.terminate();
            return false;
          }
          this.#executor = executor;
          this.#epoch = epoch;
          options.adopt();
          return true;
        },
        () => false,
      )
      .then((recovered) => {
        if (!recovered && !options.disposed()) options.failed?.();
        return recovered;
      })
      .finally(() => {
        this.#pending = undefined;
      });
    return this.#pending;
  }

  private takeFallback(): ((epoch: number) => DocumentRuntimePort) | undefined {
    if (this.#fallbackUsed) return undefined;
    this.#fallbackUsed = true;
    return this.factories.createFallback;
  }
}
