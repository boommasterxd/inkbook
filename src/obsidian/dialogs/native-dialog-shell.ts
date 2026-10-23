import { Modal, type App } from "obsidian";

interface NativeDialogCallbacks {
  open(): void;
  close(): void;
  closed(): void;
}

/** Forwards public Obsidian lifecycle callbacks to the platform-independent dialog owner. */
export class NativeDialogShell extends Modal {
  public readonly motionBackdropEl: HTMLElement;
  readonly #callbacks: NativeDialogCallbacks;

  public constructor(app: App, callbacks: NativeDialogCallbacks) {
    super(app);
    this.#callbacks = callbacks;
    // Modal documents this class and container structure; retain a direct owned Motion target.
    this.motionBackdropEl = this.containerEl.createDiv({
      cls: "modal-bg inkbook-modal-backdrop",
      attr: { "aria-hidden": "true" },
    });
    this.containerEl.replaceChildren(this.motionBackdropEl, this.modalEl);
  }

  public override onOpen(): void {
    this.motionBackdropEl.addEventListener("click", this.#requestClose);
    this.#callbacks.open();
  }

  public override close(): void {
    this.#callbacks.close();
  }

  public closeImmediately(): void {
    super.close();
  }

  public override onClose(): void {
    this.motionBackdropEl.removeEventListener("click", this.#requestClose);
    this.#callbacks.closed();
  }

  #requestClose = (): void => this.close();
}
