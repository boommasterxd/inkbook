/** Owns speculative file-contour admission for one mounted presentation. */
export class ActiveScenePrewarmBinding {
  readonly #document: Document;
  readonly #observer: IntersectionObserver | undefined;
  #enabled = true;
  #visible = false;
  #admitted: boolean | undefined;
  #disposed = false;

  public constructor(
    private readonly root: HTMLElement,
    private readonly setDocumentPrewarmEnabled: (enabled: boolean) => void,
  ) {
    this.#document = root.ownerDocument;
    const observerConstructor = this.#document.defaultView?.IntersectionObserver;
    if (observerConstructor !== undefined) {
      this.#observer = new observerConstructor((entries) => {
        if (this.#disposed) return;
        // This observer owns exactly one target; use its latest queued observation.
        const entry = entries[entries.length - 1];
        if (entry?.target !== this.root) return;
        this.#visible =
          entry.isIntersecting &&
          entry.intersectionRect.width > 0 &&
          entry.intersectionRect.height > 0;
        this.#update();
      });
      this.#observer.observe(root);
    } else this.#visible = true;
    this.#document.addEventListener("visibilitychange", this.#update);
    this.#update();
  }

  public setEnabled(enabled: boolean): void {
    if (this.#disposed) return;
    this.#enabled = enabled;
    this.#update();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.setEnabled(false);
    this.#disposed = true;
    this.#document.removeEventListener("visibilitychange", this.#update);
    this.#observer?.disconnect();
  }

  readonly #update = (): void => {
    if (this.#disposed) return;
    const admitted =
      this.#enabled && this.#visible && !this.#document.hidden && this.root.isConnected;
    if (admitted === this.#admitted) return;
    this.#admitted = admitted;
    this.setDocumentPrewarmEnabled(admitted);
  };
}
