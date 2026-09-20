/** One session's interactive leases defer background checkpoints without dropping work. */
export class InteractiveWorkPriority {
  #depth = 0;
  #releaseInput: (() => void) | undefined;
  #disposed = false;
  #pending: Promise<void> | undefined;
  #resume: (() => void) | undefined;

  public begin(): () => void {
    if (this.#disposed) return () => undefined;
    this.#depth += 1;
    this.#pending ??= new Promise((resolve) => {
      this.#resume = resolve;
    });
    let released = false;
    return () => {
      if (released || this.#disposed) return;
      released = true;
      this.#depth -= 1;
      if (this.#depth === 0) this.#release();
    };
  }

  public setInputActive(active: boolean): void {
    if (active) this.#releaseInput ??= this.begin();
    else {
      this.#releaseInput?.();
      this.#releaseInput = undefined;
    }
  }

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = this.begin();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  public async waitForBackground(): Promise<void> {
    // Recheck when a new interactive operation starts before a resumed waiter runs.
    while (this.#pending !== undefined) await this.#pending;
  }

  public dispose(): void {
    this.#disposed = true;
    this.#releaseInput = undefined;
    this.#depth = 0;
    this.#release();
  }

  #release(): void {
    const resume = this.#resume;
    this.#pending = undefined;
    this.#resume = undefined;
    resume?.();
  }
}
