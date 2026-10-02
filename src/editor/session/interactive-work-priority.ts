/** One session's interactive leases defer background checkpoints without dropping work. */
export class InteractiveWorkPriority {
  #depth = 0;
  readonly #inputReleases = new Map<"gesture" | "navigation", () => void>();
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

  public get inputActive(): boolean {
    return this.#inputReleases.size > 0;
  }

  public setInputActive(active: boolean, source: "gesture" | "navigation" = "gesture"): void {
    if (this.#disposed) return;
    if (active) {
      if (!this.#inputReleases.has(source)) this.#inputReleases.set(source, this.begin());
    } else {
      this.#inputReleases.get(source)?.();
      this.#inputReleases.delete(source);
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

  public waitForBackground(): Promise<void> | undefined {
    // Recheck when a new interactive operation starts before a resumed waiter runs.
    return this.#pending?.then(() => this.waitForBackground());
  }

  public dispose(): void {
    this.#disposed = true;
    this.#inputReleases.clear();
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
