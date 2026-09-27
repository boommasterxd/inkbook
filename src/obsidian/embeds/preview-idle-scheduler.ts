import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";

/** Gates preview work behind live input and the owning window's shared scheduler. */
export class PreviewIdleScheduler {
  readonly #abort = new AbortController();
  #waitForBackground: (() => Promise<void>) | undefined;
  #disposed = false;
  readonly #waiting = new Set<() => void>();

  public constructor(private readonly workScheduler: WorkScheduler) {}

  public setBackgroundWait(wait: (() => Promise<void>) | undefined): void {
    this.#waitForBackground = wait;
  }

  public async checkpoint(initial = false): Promise<void> {
    // Allow the presentation to install its input-priority gate before the first slice.
    if (initial) await Promise.resolve();
    await this.waitForBackground();
    if (this.#disposed) return;
    try {
      if (initial) await this.workScheduler.checkpoint(this.#abort.signal);
      else await this.workScheduler.nextFrame(this.#abort.signal);
    } catch (error: unknown) {
      if (!this.#disposed) throw error;
    }
    await this.waitForBackground();
  }

  public async waitForBackground(signal?: AbortSignal): Promise<void> {
    if (this.#disposed || signal?.aborted === true || this.#waitForBackground === undefined) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        this.#waiting.delete(finish);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      this.#waiting.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
      void this.#waitForBackground?.().then(finish, (error: unknown) => {
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
