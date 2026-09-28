/** Resumes background work when the host reports that input is inactive. */
export class InputActivityGate {
  readonly #isActive: () => boolean;
  readonly #waiters = new Set<() => void>();

  public constructor(isActive: () => boolean) {
    this.#isActive = isActive;
  }

  public notifyInactive(): void {
    for (const resume of this.#waiters) resume();
    this.#waiters.clear();
  }

  public waitUntilInactive(signal: AbortSignal): Promise<void> | undefined {
    signal.throwIfAborted();
    return this.#isActive() ? this.#wait(signal) : undefined;
  }

  async #wait(signal: AbortSignal): Promise<void> {
    while (this.#isActive()) {
      signal.throwIfAborted();
      await new Promise<void>((resolve) => {
        const resume = (): void => {
          this.#waiters.delete(resume);
          signal.removeEventListener("abort", resume);
          resolve();
        };
        this.#waiters.add(resume);
        signal.addEventListener("abort", resume, { once: true });
      });
    }
    signal.throwIfAborted();
  }
}
