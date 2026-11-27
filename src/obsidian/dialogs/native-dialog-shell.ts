import { Modal, setIcon, type App } from "obsidian";
import { Localization } from "../../domain/localization";
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
  readonly #closeButton: HTMLButtonElement;
  #releaseLanguage: (() => void) | undefined;

  public constructor(
    app: App,
    callbacks: NativeDialogCallbacks,
    private readonly localization = new Localization(),
  ) {
    super(app);
    this.#callbacks = callbacks;
    // Modal documents this class and container structure; retain a direct owned Motion target.
    this.motionBackdropEl = this.containerEl.createDiv({
      cls: "modal-bg inkbook-modal-backdrop",
      attr: { "aria-hidden": "true" },
    });
    this.containerEl.replaceChildren(this.motionBackdropEl, this.modalEl);
    const header = this.modalEl.createDiv({ cls: "inkbook-dialog-header" });
    header.append(this.titleEl);
    this.titleEl.classList.add("inkbook-dialog-title");
    this.titleEl.tabIndex = -1;
    this.#closeButton = header.createEl("button", {
      cls: "clickable-icon inkbook-dialog-close",
      type: "button",
    });
    setIcon(this.#closeButton, "x");
    this.modalEl.replaceChildren(header, this.contentEl);
    this.scope.register(null, "Tab", this.#cycleFocus);
  }

  public override open(): void {
    super.open();
    if (!this.modalEl.isConnected || this.modalEl.inert) return;
    const active = this.modalEl.ownerDocument.activeElement;
    const initial = this.contentEl.querySelector<HTMLElement>("[autofocus]:not(:disabled)");
    if (initial && !initial.closest("[hidden], [inert]")) initial.focus({ preventScroll: true });
    else if (!this.modalEl.contains(active)) this.titleEl.focus({ preventScroll: true });
  }

  public override onOpen(): void {
    this.motionBackdropEl.addEventListener("click", this.#requestClose);
    this.#closeButton.addEventListener("click", this.#requestClose);
    this.#labelCloseButton();
    this.#releaseLanguage = this.localization.subscribe(this.#labelCloseButton);
    this.#callbacks.open();
  }

  public override close(): void {
    this.#callbacks.close();
  }

  public closeImmediately(): void {
    super.close();
  }

  public override onClose(): void {
    this.#releaseLanguage?.();
    this.#closeButton.removeEventListener("click", this.#requestClose);
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

  #labelCloseButton = (): void => {
    this.#closeButton.setAttribute("aria-label", this.localization.t("host.dialog.close"));
  };

  #requestClose = (): void => this.close();
}
