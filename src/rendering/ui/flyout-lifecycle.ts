export interface FlyoutDismissalOptions {
  readonly anchor: HTMLElement;
  readonly canvasInput: HTMLElement | null;
  readonly onCanvasClose: () => void;
  readonly onEscapeClose: () => void;
  readonly ownerDocument: Document;
}

export function createFlyoutPortalHost(ownerDocument: Document): HTMLElement {
  return ownerDocument.body.createDiv({ cls: "inkbook-root inkbook-portal-root" });
}

export function registerFlyoutDismissal(options: FlyoutDismissalOptions): () => void {
  let active = true;
  const cleanup = (): void => {
    if (!active) return;
    active = false;
    options.ownerDocument.removeEventListener("keydown", closeFromEscape, true);
    options.canvasInput?.removeEventListener("pointerdown", closeFromCanvas, true);
  };
  const closeFromEscape = (event: KeyboardEvent): void => {
    if (!active || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cleanup();
    options.onEscapeClose();
    options.anchor.focus();
  };
  const closeFromCanvas = (): void => {
    if (!active) return;
    cleanup();
    options.onCanvasClose();
  };

  options.ownerDocument.addEventListener("keydown", closeFromEscape, true);
  options.canvasInput?.addEventListener("pointerdown", closeFromCanvas, true);

  return cleanup;
}
