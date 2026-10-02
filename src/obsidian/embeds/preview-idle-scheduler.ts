import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";

/** Gates preview work behind live input and the owning window's shared scheduler. */
export class PreviewIdleScheduler {
  readonly #abort = new AbortController();
  #waitForBackground: (() => Promise<void> | undefined) | undefined;
  #disposed = false;
  readonly #waiting = new Set<() => void>();

  public constructor(private readonly workScheduler: WorkScheduler) {}

  public setBackgroundWait(wait: (() => Promise<void> | undefined) | undefined): void {
    this.#waitForBackground = wait;
  }

  public checkpoint(initial = false): Promise<void> | undefined {
    // Allow the presentation to install its input-priority gate before the first slice.
    if (initial) return Promise.resolve().then(() => this.checkpoint());
    if (this.#disposed) return;
    const ready = this.waitForBackground();
    return ready === undefined ? this.#admit() : ready.then(() => this.#admit());
  }

  #admit(): Promise<void> | undefined {
    if (this.#disposed) return;
    try {
      const pending = this.workScheduler.checkpoint(this.#abort.signal);
      if (pending !== undefined) {
        return pending.then(
          () => this.waitForBackground(),
          (error: unknown) => {
            if (!this.#disposed) throw error;
          },
        );
      }
    } catch (error: unknown) {
      if (!this.#disposed) throw error;
    }
    return this.waitForBackground();
  }

  public waitForBackground(signal?: AbortSignal): Promise<void> | undefined {
    if (this.#disposed || signal?.aborted === true || this.#waitForBackground === undefined) return;
    const pending = this.#waitForBackground();
    if (pending === undefined || this.#disposed || Boolean(signal?.aborted)) return;
    return new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        this.#waiting.delete(finish);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      this.#waiting.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
      void pending.then(finish, (error: unknown) => {
        this.#waiting.delete(finish);
        signal?.removeEventListener("abort", finish);
        reject(error instanceof Error ? error : new Error("Preview scheduling failed."));
      });
    });
  }

  public dispose(): void {
    this.#disposed = true;
    this.#waitForBackground = undefined;
    this.#abort.abort();
    for (const finish of this.#waiting) finish();
  }
}
