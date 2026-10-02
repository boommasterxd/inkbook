export class SceneCommitCoordinator {
  #pending = false;
  #generation = 0;
  #released = false;

  public constructor(private readonly notify: (() => void) | undefined) {}

  public get pending(): boolean {
    return this.#pending;
  }

  public get proof(): number | undefined {
    return this.#pending || this.#released ? undefined : this.#generation;
  }

  public markPending(): void {
    this.#generation += 1;
    this.#pending = true;
  }

  public completeFrame(): void {
    if (!this.#pending) return;
    this.#pending = false;
    this.notify?.();
  }

  public release(): void {
    this.#pending = false;
    this.#released = true;
  }
}
