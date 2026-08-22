export class SceneCommitCoordinator {
  #pending = false;

  public constructor(private readonly notify: (() => void) | undefined) {}

  public get pending(): boolean {
    return this.#pending;
  }

  public markPending(): void {
    this.#pending = true;
  }

  public completeFrame(): void {
    if (!this.#pending) return;
    this.#pending = false;
    this.notify?.();
  }

  public release(): void {
    this.#pending = false;
  }
}
