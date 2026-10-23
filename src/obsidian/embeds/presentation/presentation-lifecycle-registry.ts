export class PresentationLifecycleRegistry {
  readonly #disposers = new Map<HTMLElement, () => void>();
  #disposed = false;

  register(root: HTMLElement, dispose: () => void): (() => void) | undefined {
    if (this.#disposed) return undefined;
    const previous = this.#disposers.get(root);
    if (previous !== undefined) {
      this.#disposers.delete(root);
      previous();
    }
    this.#disposers.set(root, dispose);
    return () => {
      if (this.#disposers.get(root) === dispose) this.#disposers.delete(root);
    };
  }

  dispose(root: HTMLElement): void {
    const dispose = this.#disposers.get(root);
    if (dispose === undefined) return;
    this.#disposers.delete(root);
    dispose();
  }

  disposeAll(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const disposers = [...this.#disposers.values()];
    this.#disposers.clear();
    for (const dispose of disposers) dispose();
  }
}
