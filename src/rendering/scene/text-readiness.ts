import type { SceneContentRenderer } from "./content-renderer";
import type { SceneDom } from "./scene-dom";

interface PendingTextReady {
  readonly id: string;
  readonly resolve: () => void;
  readonly reject: (reason: Error) => void;
  readonly cleanup: () => void;
}

/** Resolves after actual authoritative text publication, with one bounded active waiter. */
export class SceneTextReadiness {
  #pending: PendingTextReady | undefined;
  #watching = false;
  #released = false;
  public constructor(
    private readonly context: () => readonly [SceneDom, SceneContentRenderer],
    private readonly onRemoved: (id: string) => void,
    private readonly onPublished?: (id: string) => void,
  ) {}

  public watch(): void {
    if (this.#watching || this.#released) return;
    this.#watching = true;
    this.context()[1].onTextElementStateChanged = (id, state) => {
      if (state === "removed") {
        this.onRemoved(id);
        if (this.#pending?.id === id) this.cancel("The text element was removed.");
      } else if (this.#pending?.id === id && this.context()[1].textReady(id)) {
        const pending = this.#pending;
        this.#pending = undefined;
        pending.cleanup();
        pending.resolve();
      }
      if (state === "published") this.onPublished?.(id);
    };
  }

  public readonly wait = async (id: string, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    if (this.#released) throw new Error("The text scene has been released.");
    this.watch();
    const [dom, content] = this.context();
    if (content.textReady(id)) return;
    this.cancel("A newer text readiness request replaced this request.");
    return new Promise<void>((resolve, reject) => {
      const abort = () => this.cancel("The text readiness request was aborted.");
      this.#pending = {
        id,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      };
      signal?.addEventListener("abort", abort, { once: true });
      content.promoteVisible(id);
      dom.onSurfaceInvalidated();
    });
  };

  public release(): void {
    this.cancel("The text scene has been released.");
    this.#released = true;
    if (this.#watching) this.context()[1].onTextElementStateChanged = () => undefined;
  }

  private cancel(message: string): void {
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.cleanup();
    const error = new Error(message);
    error.name = "AbortError";
    pending?.reject(error);
  }
}
