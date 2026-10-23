interface RegisteredPresentation {
  readonly dispose: () => void;
  readonly onOwnerDocumentChanged?: () => void;
  ownerDocument: Document;
}

export class PresentationLifecycleRegistry {
  readonly #presentations = new Map<HTMLElement, RegisteredPresentation>();
  #disposed = false;

  register(
    root: HTMLElement,
    dispose: () => void,
    onOwnerDocumentChanged?: () => void,
  ): (() => void) | undefined {
    if (this.#disposed) return undefined;
    const previous = this.#presentations.get(root);
    if (previous !== undefined) {
      this.#presentations.delete(root);
      previous.dispose();
    }
    const presentation: RegisteredPresentation = {
      dispose,
      ownerDocument: root.ownerDocument,
      ...(onOwnerDocumentChanged === undefined ? {} : { onOwnerDocumentChanged }),
    };
    this.#presentations.set(root, presentation);
    return () => {
      if (this.#presentations.get(root) === presentation) this.#presentations.delete(root);
    };
  }

  refreshOwnerDocuments(): void {
    for (const [root, presentation] of this.#presentations) {
      if (root.ownerDocument === presentation.ownerDocument) continue;
      presentation.onOwnerDocumentChanged?.();
      presentation.ownerDocument = root.ownerDocument;
    }
  }

  dispose(root: HTMLElement): void {
    const presentation = this.#presentations.get(root);
    if (presentation === undefined) return;
    this.#presentations.delete(root);
    presentation.dispose();
  }

  disposeAll(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const presentations = [...this.#presentations.values()];
    this.#presentations.clear();
    for (const presentation of presentations) presentation.dispose();
  }
}
