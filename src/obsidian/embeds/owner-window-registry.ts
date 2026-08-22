export class OwnerWindowRegistry {
  readonly #windows = new Map<string, WeakRef<Window>>();

  clear(): void {
    this.#windows.clear();
  }

  observe(documentId: string, ownerWindow: Window | null): void {
    if (ownerWindow === null || !isLiveOwnerWindow(ownerWindow)) {
      this.#windows.delete(documentId);
      return;
    }
    this.#windows.set(documentId, new WeakRef(ownerWindow));
  }

  prune(retainedDocumentIds: ReadonlySet<string>): void {
    for (const documentId of this.#windows.keys()) {
      if (!retainedDocumentIds.has(documentId)) this.#windows.delete(documentId);
    }
  }

  resolve(documentId: string): Window | undefined {
    const ownerWindow = this.#windows.get(documentId)?.deref();
    if (ownerWindow === undefined || !isLiveOwnerWindow(ownerWindow)) {
      this.#windows.delete(documentId);
      return undefined;
    }
    return ownerWindow;
  }
}

export function isLiveOwnerWindow(ownerWindow: Window | undefined): ownerWindow is Window {
  if (ownerWindow === undefined) return false;
  try {
    if (ownerWindow.closed) return false;
    const ownerDocument = ownerWindow.document;
    return ownerDocument === undefined || ownerDocument.defaultView === ownerWindow;
  } catch {
    return false;
  }
}
