/** Mount owned feedback outside note clipping while retaining its presentation styling. */
export function mountWindowFeedback(element: HTMLElement, source: HTMLElement): () => void {
  const body = source.ownerDocument.body;
  const host =
    body.getElementsByClassName("inkbook-feedback-host").item(0) ??
    body.createDiv({ cls: "inkbook-root inkbook-feedback-host" });
  const slot = (host as HTMLElement).createDiv({ cls: "inkbook-root inkbook-feedback-slot" });
  const unbindStyle = bindFeedbackPresentationStyle(slot, source);
  slot.append(element);
  return () => {
    unbindStyle();
    slot.remove();
    if (host.children.length === 0) host.remove();
  };
}

/** Retains the originating presentation's scheme and motion in an owned external surface. */
export function bindFeedbackPresentationStyle(
  target: HTMLElement,
  source: HTMLElement,
): () => void {
  const syncStyle = (): void => {
    for (const key of ["inkbookScheme", "inkbookMotion"] as const) {
      const value = source.dataset[key];
      if (value === undefined) delete target.dataset[key];
      else if (target.dataset[key] !== value) target.dataset[key] = value;
    }
  };
  syncStyle();
  const observer = observeSourceStyle(source, syncStyle);
  return () => observer?.disconnect();
}

function observeSourceStyle(
  source: HTMLElement,
  syncStyle: () => void,
): MutationObserver | undefined {
  const ownerWindow = source.ownerDocument.defaultView;
  if (ownerWindow === null || !("MutationObserver" in ownerWindow)) return undefined;
  const observer = new ownerWindow.MutationObserver(syncStyle);
  observer.observe(source, {
    attributes: true,
    attributeFilter: ["data-inkbook-scheme", "data-inkbook-motion"],
  });
  return observer;
}
