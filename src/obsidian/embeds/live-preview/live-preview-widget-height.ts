/** Retains measured block height while CodeMirror replaces a saved preview decoration. */
export class LivePreviewWidgetHeight {
  #value = -1;

  public get value(): number {
    return this.#value;
  }

  public observe(root: HTMLElement): () => void {
    const ownerWindow = root.ownerDocument.defaultView;
    if (ownerWindow === null) return () => undefined;
    const observer = new ownerWindow.ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target !== root) continue;
        const height = entry.borderBoxSize[0]?.blockSize;
        if (height !== undefined && Number.isFinite(height) && height > 0) this.#value = height;
      }
    });
    observer.observe(root, { box: "border-box" });
    return () => {
      observer.disconnect();
      this.#value = -1;
    };
  }
}
