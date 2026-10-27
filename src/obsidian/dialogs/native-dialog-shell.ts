import { Modal, type App } from "obsidian";
import { cycleModalFocus } from "../runtime/focus-navigation";

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
    this.scope.register(null, "Tab", this.#cycleFocus);
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

  #cycleFocus = (event: KeyboardEvent): false => {
    const controls = [
      ...this.modalEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter(
      (element) =>
        !element.hasAttribute("disabled") &&
        element.tabIndex !== -1 &&
        element.closest("[hidden], [inert]") === null,
    );
    if (controls.length === 0) this.modalEl.tabIndex = -1;
    cycleModalFocus(event, controls.length === 0 ? [this.modalEl] : controls);
    return false;
  };

  #requestClose = (): void => this.close();
}
