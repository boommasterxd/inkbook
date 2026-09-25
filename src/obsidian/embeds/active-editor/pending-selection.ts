/** Owns selection work after its pointer gesture has finished. */
export class PendingSelection {
  #controller = new AbortController();

  public get signal(): AbortSignal {
    if (this.#controller.signal.aborted) this.#controller = new AbortController();
    return this.#controller.signal;
  }

  public cancel(): void {
    this.#controller.abort();
  }
}
