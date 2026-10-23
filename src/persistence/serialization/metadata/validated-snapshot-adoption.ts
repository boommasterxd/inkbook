import type { InkSnapshotV1, SnapshotValidationDerivations } from "../../../domain/schema/public";

export type ValidatedSnapshotConsumer = (
  snapshot: InkSnapshotV1,
  derivations: SnapshotValidationDerivations,
  signal: AbortSignal,
) => Promise<void> | void;

/** One cancellable adoption task overlaps safe suffix inspection without publishing a model. */
export class ValidatedSnapshotAdoption {
  readonly #controller = new AbortController();
  readonly #signal: AbortSignal;
  #pending: Promise<void> | undefined;
  #failed = false;
  #error: unknown;

  public constructor(signal?: AbortSignal) {
    this.#signal =
      signal === undefined
        ? this.#controller.signal
        : AbortSignal.any([signal, this.#controller.signal]);
  }

  public start(
    snapshot: InkSnapshotV1,
    derivations: SnapshotValidationDerivations,
    consumer: ValidatedSnapshotConsumer | undefined,
  ): void {
    try {
      const pending = consumer?.(snapshot, derivations, this.#signal);
      if (pending !== undefined)
        this.#pending = pending.catch((error: unknown) => {
          this.#failed = true;
          this.#error = error;
        });
    } catch (error) {
      this.#failed = true;
      this.#error = error;
    }
  }

  public async finish(): Promise<void> {
    await this.#pending;
    this.#signal.throwIfAborted();
    if (this.#failed) throw this.#error;
  }

  public cancel(): void {
    this.#controller.abort();
  }

  public settle(): Promise<void> | undefined {
    return this.#pending;
  }
}
