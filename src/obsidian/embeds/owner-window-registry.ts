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

  require(
    documentId: string,
    presentations: Iterable<OwnedPresentation>,
    fallback: () => Window | undefined,
  ): Window {
    const mounted = resolvePresentationWindow(documentId, presentations);
    if (mounted !== undefined) return mounted;
    const retained = this.resolve(documentId);
    if (retained !== undefined) return retained;
    const candidate = fallback();
    if (candidate !== undefined) return candidate;
    throw new Error("The Inkbook presentation has no owning window.");
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

interface OwnedPresentation {
  readonly attachment: {
    readonly documentId: string;
    readonly root: HTMLElement;
  };
}

export function resolvePresentationWindow(
  documentId: string,
  presentations: Iterable<OwnedPresentation>,
): Window | undefined {
  for (const mounted of presentations) {
    if (mounted.attachment.documentId !== documentId) continue;
    const ownerWindow = mounted.attachment.root.ownerDocument.defaultView ?? undefined;
    if (isLiveOwnerWindow(ownerWindow)) return ownerWindow;
  }
  return undefined;
}

export function resolveFallbackWindow(
  currentDocumentId: string | undefined,
  presentations: Iterable<OwnedPresentation>,
  registry: OwnerWindowRegistry,
  fallback: () => Window | undefined,
): Window | undefined {
  const mounted = [...presentations];
  if (currentDocumentId !== undefined) {
    const current = resolvePresentationWindow(currentDocumentId, mounted);
    if (current !== undefined) return current;
    const retained = registry.resolve(currentDocumentId);
    if (retained !== undefined) return retained;
  }
  for (const presentation of mounted) {
    const ownerWindow = presentation.attachment.root.ownerDocument.defaultView ?? undefined;
    if (isLiveOwnerWindow(ownerWindow)) return ownerWindow;
  }
  const candidate = fallback();
  return isLiveOwnerWindow(candidate) ? candidate : undefined;
}

export function pruneOwnerWindowRegistry(
  registry: OwnerWindowRegistry,
  presentations: Iterable<OwnedPresentation>,
  currentDocumentId: string | undefined,
): void {
  const retained = new Set<string>();
  for (const mounted of presentations) retained.add(mounted.attachment.documentId);
  if (currentDocumentId !== undefined) retained.add(currentDocumentId);
  registry.prune(retained);
}
