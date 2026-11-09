type RecognitionListener = (documentId: string) => void;

/** Routes file changes to their owning presentations and shared note views. */
export class DocumentRecognitionSubscriptions {
  readonly #global = new Set<RecognitionListener>();
  readonly #documents = new Map<string, Set<RecognitionListener>>();

  subscribe(listener: RecognitionListener, documentId?: string): () => void {
    let listeners = this.#global;
    if (documentId !== undefined) {
      const existing = this.#documents.get(documentId);
      listeners = existing ?? new Set();
      if (existing === undefined) this.#documents.set(documentId, listeners);
    }
    listeners.add(listener);
    const owned = listeners;
    return () => {
      owned.delete(listener);
      if (documentId !== undefined && owned.size === 0 && this.#documents.get(documentId) === owned)
        this.#documents.delete(documentId);
    };
  }

  notify(documentId: string): void {
    notifyListeners(this.#global, documentId);
    notifyListeners(this.#documents.get(documentId), documentId);
  }

  clear(): void {
    this.#global.clear();
    for (const listeners of this.#documents.values()) listeners.clear();
    this.#documents.clear();
  }
}

function notifyListeners(
  listeners: ReadonlySet<RecognitionListener> | undefined,
  documentId: string,
): void {
  if (listeners === undefined) return;
  for (const listener of listeners) {
    try {
      listener(documentId);
    } catch {
      // One failed presentation must not block other subscribers or queued recognition.
    }
  }
}
