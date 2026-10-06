import type { DocumentModelRuntime } from "./document-model";

/** Serializer prewarming has no queue ownership and yields to admitted document jobs. */
export class DocumentPrewarm {
  #requested = false;
  #controller: AbortController | undefined;
  public constructor(
    private readonly model: DocumentModelRuntime,
    private readonly checkpoint: (signal: AbortSignal) => Promise<void> | undefined,
    private readonly eligible: () => boolean,
  ) {}

  public request(): void {
    this.#requested = true;
    this.schedule();
  }

  public interrupt(): void {
    this.#controller?.abort();
  }

  public clear(): void {
    this.#requested = false;
    this.interrupt();
  }

  public schedule(): void {
    if (!this.#requested || this.#controller !== undefined || !this.eligible()) return;
    const controller = new AbortController();
    this.#controller = controller;
    void this.run(controller);
  }

  private async run(controller: AbortController): Promise<void> {
    try {
      const pending = this.checkpoint(controller.signal);
      if (pending !== undefined) await pending;
      while (this.#requested && this.eligible()) {
        controller.signal.throwIfAborted();
        const hasMore = await this.model.prewarmOne({
          checkpoint: () => this.checkpoint(controller.signal),
          signal: controller.signal,
        });
        if (!hasMore) {
          this.#requested = false;
          break;
        }
      }
    } catch {
      if (!controller.signal.aborted) this.#requested = false;
    } finally {
      this.#controller = undefined;
      this.schedule();
    }
  }
}
