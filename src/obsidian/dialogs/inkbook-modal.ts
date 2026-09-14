import { InkbookMotionModal } from "./inkbook-motion-modal";

/** Shared Obsidian shell and owned listener lifetime for Inkbook dialogs. */
export class InkbookModal extends InkbookMotionModal {
  readonly #listeners: Array<() => void> = [];
  protected closed = false;

  public override onOpen(): void {
    super.onOpen();
    this.containerEl.classList.add("inkbook-dialog-container");
    this.modalEl.classList.add("inkbook-action-dialog");
    this.titleEl.classList.add("inkbook-dialog-content-spacing");
    this.contentEl.classList.add("inkbook-dialog-content-spacing");
    this.modalEl.setAttribute("role", "dialog");
    this.modalEl.setAttribute("aria-modal", "true");
  }

  public override onClose(): void {
    if (this.closed) return;
    this.closed = true;
    super.onClose();
    for (const remove of this.#listeners) remove();
    this.#listeners.length = 0;
    this.contentEl.replaceChildren();
  }

  protected listen(target: EventTarget, type: string, listener: () => void): void {
    target.addEventListener(type, listener);
    this.#listeners.push(() => target.removeEventListener(type, listener));
  }
}
