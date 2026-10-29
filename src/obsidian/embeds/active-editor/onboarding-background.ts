import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";

export interface OnboardingBackgroundPort {
  readonly setMinimumBlockSize: (minimum: number) => void;
  readonly readCommitProof: () => number | undefined;
}

/** Prepares the existing scene pattern before revealing extra presentation space. */
export class OnboardingBackground {
  readonly #scheduler: WorkScheduler;
  readonly #port: OnboardingBackgroundPort | undefined;
  #minimum = 0;
  #frame: number | undefined;
  #generation = 0;

  public constructor(scheduler: WorkScheduler, port?: OnboardingBackgroundPort) {
    this.#scheduler = scheduler;
    this.#port = port;
  }

  public prepare(minimum: number, onReady: () => void): void {
    this.#cancel();
    if (this.#port === undefined || minimum === 0) return onReady();
    this.#setMinimum(Math.max(minimum, this.#minimum));
    this.#waitForPaint(onReady);
  }

  public settle(minimum: number): void {
    this.#setMinimum(minimum);
  }

  public dispose(): void {
    this.#cancel();
    this.#setMinimum(0);
  }

  #setMinimum(minimum: number): void {
    if (minimum === this.#minimum) return;
    this.#minimum = minimum;
    this.#port?.setMinimumBlockSize(minimum);
  }

  #waitForPaint(onReady: () => void, generation = this.#generation): void {
    this.#frame = this.#scheduler.requestFrame(() => {
      if (generation !== this.#generation) return;
      this.#frame = undefined;
      const proof = this.#port?.readCommitProof();
      if (proof === undefined) return this.#waitForPaint(onReady, generation);
      this.#frame = this.#scheduler.requestFrame(() => {
        if (generation !== this.#generation) return;
        this.#frame = undefined;
        if (proof !== this.#port?.readCommitProof()) return this.#waitForPaint(onReady, generation);
        onReady();
      });
    });
  }

  #cancel(): void {
    this.#generation += 1;
    if (this.#frame !== undefined) this.#scheduler.cancelFrame(this.#frame);
    this.#frame = undefined;
  }
}
