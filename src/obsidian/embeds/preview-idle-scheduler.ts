/** One cancellable owning-window idle callback per preview preparation. */
export class PreviewIdleScheduler {
  #cancel: (() => void) | undefined;
  #waitForBackground: (() => Promise<void>) | undefined;
  #disposed = false;
  #foregroundRequests = 0;
  readonly #waiting = new Set<() => void>();

  public constructor(private readonly ownerWindow: Window) {}

  public setBackgroundWait(wait: (() => Promise<void>) | undefined): void {
    this.#waitForBackground = wait;
  }

  public promote(): void {
    this.#foregroundRequests += 1;
    this.#cancel?.();
  }

  public demote(): void {
    this.#foregroundRequests = Math.max(0, this.#foregroundRequests - 1);
  }

  public async checkpoint(): Promise<void> {
    await this.waitForBackground();
    if (this.#disposed) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        this.#cancel = undefined;
        resolve();
      };
      const channelConstructor = (
        this.ownerWindow as Window & { MessageChannel?: typeof MessageChannel }
      ).MessageChannel;
      if (this.#foregroundRequests > 0 && channelConstructor !== undefined) {
        const channel = new channelConstructor();
        const close = (): void => {
          channel.port1.close();
          channel.port2.close();
          finish();
        };
        channel.port1.onmessage = close;
        this.#cancel = close;
        try {
          channel.port2.postMessage(null);
        } catch (error: unknown) {
          channel.port1.close();
          channel.port2.close();
          this.#cancel = undefined;
          reject(error instanceof Error ? error : new Error("Preview handoff failed."));
        }
      } else if (
        this.#foregroundRequests === 0 &&
        typeof this.ownerWindow.requestIdleCallback === "function"
      ) {
        const id = this.ownerWindow.requestIdleCallback(finish, { timeout: 100 });
        this.#cancel = () => {
          this.ownerWindow.cancelIdleCallback(id);
          finish();
        };
      } else {
        const id = this.ownerWindow.setTimeout(finish, this.#foregroundRequests > 0 ? 0 : 16);
        this.#cancel = () => {
          this.ownerWindow.clearTimeout(id);
          finish();
        };
      }
    });
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
    for (const finish of this.#waiting) finish();
    this.#cancel?.();
  }
}
