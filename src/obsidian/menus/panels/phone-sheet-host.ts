import { Modal, type App } from "obsidian";

/** Public host lifecycle needed by the shared sheet without exposing the application. */
export interface PhoneSheetHostPort {
  readonly containerEl: HTMLElement;
  readonly modalEl: HTMLElement;
  open(onRequestClose: () => void): void;
  close(): void;
}

/** Uses the actual native modal surface so Android Back belongs to the open sheet. */
class PhoneSheetModal extends Modal {
  #requestClose: (() => void) | undefined;
  #opened = false;

  public constructor(app: App) {
    super(app);
    this.shouldRestoreSelection = false;
    this.containerEl.className = "inkbook-phone-sheet-host";
    this.modalEl.className = "inkbook-phone-sheet-host-surface";
    this.modalEl.replaceChildren();
    this.containerEl.replaceChildren(this.modalEl);
  }

  public mount(onRequestClose: () => void): void {
    this.#requestClose = onRequestClose;
    this.#opened = true;
    super.open();
  }

  public override close(): void {
    this.#requestClose?.();
  }

  public dispose(): void {
    if (!this.#opened) return;
    this.#opened = false;
    this.#requestClose = undefined;
    // Native close releases history and keymap synchronously; the sheet owns its visual exit.
    super.close();
    this.containerEl.remove();
  }
}

export function createPhoneSheetHost(app: App): PhoneSheetHostPort {
  const modal = new PhoneSheetModal(app);
  return {
    containerEl: modal.containerEl,
    modalEl: modal.modalEl,
    open: (onRequestClose) => modal.mount(onRequestClose),
    close: () => modal.dispose(),
  };
}
