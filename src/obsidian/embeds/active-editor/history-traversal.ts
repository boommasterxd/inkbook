import type { ActiveEditorHistory } from "./history";

export interface ActiveEditorHistoryTraversalOptions {
  readonly history: ActiveEditorHistory;
  readonly onPendingChanged: (pending: boolean) => void;
  readonly onStateChanged: () => void;
}

export class ActiveEditorHistoryTraversal {
  readonly #options: ActiveEditorHistoryTraversalOptions;
  #disposed = false;
  #pending = false;

  public constructor(options: ActiveEditorHistoryTraversalOptions) {
    this.#options = options;
  }

  public redo(): void {
    this.#run(() => this.#options.history.redoAsync());
  }

  public dispose(): void {
    this.#disposed = true;
  }

  public undo(): void {
    this.#run(() => this.#options.history.undoAsync());
  }

  #run(operation: () => Promise<boolean>): void {
    if (this.#pending || this.#disposed) return;
    this.#pending = true;
    this.#options.onPendingChanged(true);
    void operation().then(this.#finish, this.#finish);
  }

  readonly #finish = (): void => {
    if (this.#disposed) return;
    this.#pending = false;
    this.#options.onPendingChanged(false);
    this.#options.onStateChanged();
  };
}
