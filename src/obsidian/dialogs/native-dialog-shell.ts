import { Modal, type App } from "obsidian";

interface NativeDialogCallbacks {
  open(): void;
  close(): void;
  closed(): void;
}

/** Forwards public Obsidian lifecycle callbacks to the platform-independent dialog owner. */
export class NativeDialogShell extends Modal {
  readonly #callbacks: NativeDialogCallbacks;

  public constructor(app: App, callbacks: NativeDialogCallbacks) {
    super(app);
    this.#callbacks = callbacks;
  }

  public override onOpen(): void {
    this.#callbacks.open();
  }

  public override close(): void {
    this.#callbacks.close();
  }

  public closeImmediately(): void {
    super.close();
  }

  public override onClose(): void {
    this.#callbacks.closed();
  }
}
