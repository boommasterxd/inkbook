import { Platform, setIcon, type App } from "obsidian";

import {
  getTransitionDuration,
  isReducedMotion,
  type MotionPreference,
} from "../../rendering/motion/transitions";
import { AdaptivePanelSession } from "../menus/adaptive-panel";
import { createPhoneSheetHost, type PhoneSheetHostPort } from "../menus/phone-sheet-host";
import { menuDomWindow } from "../menus/menu-dom";
import { NativeDialogShell } from "./native-dialog-shell";

/** Keeps native wide-screen dialogs and shares the owned phone sheet lifecycle. */
export class InkbookMotionModal {
  public readonly app: App;
  public readonly containerEl: HTMLElement;
  public readonly modalEl: HTMLElement;
  public readonly titleEl: HTMLElement;
  public readonly contentEl: HTMLElement;
  readonly #phoneHost: PhoneSheetHostPort | undefined;
  readonly #native: NativeDialogShell | undefined;
  readonly #readMotion: () => MotionPreference;
  #phone: AdaptivePanelSession | undefined;
  #animation: Animation | undefined;
  #timer: number | undefined;
  #ownerWindow: Window | null = null;
  #closing = false;
  #hostClosing = false;
  #opened = false;

  public constructor(app: App, readMotion: () => MotionPreference = () => "system") {
    this.app = app;
    this.#readMotion = readMotion;
    if (!Platform.isPhone) {
      this.#native = new NativeDialogShell(app, {
        open: () => this.onOpen(),
        close: () => this.close(),
        closed: () => this.onClose(),
      });
      this.containerEl = this.#native.containerEl;
      this.modalEl = this.#native.modalEl;
      this.titleEl = this.#native.titleEl;
      this.contentEl = this.#native.contentEl;
      return;
    }
    this.#phoneHost = createPhoneSheetHost(app);
    this.containerEl = this.#phoneHost.containerEl;
    this.modalEl = this.#phoneHost.modalEl;
    this.containerEl.classList.add("inkbook-phone-dialog");
    this.modalEl.classList.add("inkbook-phone-dialog-surface");
    const header = this.modalEl.createDiv({ cls: "inkbook-phone-dialog-header" });
    this.titleEl = header.createEl("h2", { cls: "inkbook-phone-dialog-title" });
    this.titleEl.tabIndex = -1;
    this.contentEl = this.modalEl.createDiv({ cls: "inkbook-phone-dialog-content" });
  }

  protected get closing(): boolean {
    return this.#closing;
  }

  public setTitle(title: string): void {
    if (this.#native !== undefined) this.#native.setTitle(title);
    else this.titleEl.textContent = title;
  }

  public open(): void {
    if (this.#opened || this.#closing) return;
    this.#opened = true;
    if (this.#native !== undefined) this.#native.open();
    else this.#openPhone();
    if (this.#closing) return;
    this.#ownerWindow = this.modalEl.ownerDocument.defaultView;
    this.#ownerWindow?.addEventListener("pagehide", this.#handlePageHide);
    if (this.#native !== undefined) this.#animate(false);
  }

  public onOpen(): void {
    this.#ownerWindow = this.modalEl.ownerDocument.defaultView;
    this.containerEl.classList.add("inkbook-modal-container");
    this.containerEl.dataset.inkbookModalPlatform = this.#native === undefined ? "phone" : "wide";
    this.modalEl.classList.add("inkbook-modal-surface");
    this.contentEl.classList.add("inkbook-modal-content");
  }

  public close(): void {
    if (!this.#opened || this.#closing) return;
    this.#closing = true;
    this.modalEl.inert = true;
    if (this.#phone !== undefined) this.#phone.close();
    else if (!this.#animate(true)) this.closeImmediately();
  }

  /** Owner disposal and replacement must not retain an invisible dialog or timer. */
  public closeImmediately(): void {
    if (!this.#opened || this.#hostClosing) return;
    this.#closing = true;
    this.#hostClosing = true;
    this.#cancelMotion();
    this.#ownerWindow?.removeEventListener("pagehide", this.#handlePageHide);
    if (this.#native !== undefined) this.#native.closeImmediately();
    else if (this.#phone !== undefined) this.#phone.close("immediate");
    else this.onClose();
  }

  public onClose(): void {
    this.#cancelMotion();
    this.#ownerWindow?.removeEventListener("pagehide", this.#handlePageHide);
    this.#opened = false;
    this.#phone = undefined;
  }

  #openPhone(): void {
    const ownerDocument = this.modalEl.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    if (ownerWindow === null) throw new Error("Dialogs require an owning window.");
    this.#ownerWindow = ownerWindow;
    const activeElement = ownerDocument.activeElement;
    const anchor =
      activeElement !== null && "focus" in activeElement
        ? (activeElement as HTMLElement)
        : ownerDocument.body;
    this.onOpen();
    if (this.#closing) return;
    const content = menuDomWindow(ownerDocument, "phone dialog").createFragment();
    content.append(...this.modalEl.childNodes);
    const initialFocus =
      this.contentEl.querySelector<HTMLElement>("[autofocus]") ??
      this.contentEl.querySelector<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex='0']",
      ) ??
      this.titleEl;
    this.#phone = new AdaptivePanelSession({
      anchor,
      canvasInputSurface: anchor,
      createContent: () => content,
      durationMs: this.#duration("adaptiveMenu"),
      initialFocus,
      keymap: this.app.keymap,
      kind: "dialog",
      label: this.titleEl.textContent ?? "Inkbook dialog",
      ...(this.#phoneHost === undefined ? {} : { phoneHost: this.#phoneHost }),
      onClosing: () => {
        this.#closing = true;
      },
      onClosed: () => {
        if (this.#opened) this.onClose();
      },
      ownerDocument,
      ownerWindow,
      renderIcon: setIcon,
    });
  }

  #handlePageHide = (): void => this.closeImmediately();

  #animate(exiting: boolean): boolean {
    const ownerWindow = this.#ownerWindow;
    const duration = this.#duration();
    if (ownerWindow === null || duration === 0 || typeof this.modalEl.animate !== "function") {
      this.#cancelMotion();
      return false;
    }
    const computed = exiting ? ownerWindow.getComputedStyle(this.modalEl) : undefined;
    const startScale = computed?.scale;
    const startOpacity = computed?.opacity;
    this.#cancelMotion();
    this.#animation = this.modalEl.animate(
      [
        {
          scale: !exiting ? "0.96" : !startScale || startScale === "none" ? "1" : startScale,
          opacity: exiting ? startOpacity || "1" : "0",
        },
        { scale: exiting ? "0.96" : "1", opacity: exiting ? "0" : "1" },
      ],
      { duration, easing: "ease-out", fill: "both" },
    );
    // Interrupting entry or disposing the owner rejects the Web Animations completion promise.
    void this.#animation.finished.catch(() => undefined);
    const finish = (): void => {
      if (exiting) this.closeImmediately();
      else this.#cancelMotion();
    };
    this.#animation.onfinish = finish;
    this.#animation.oncancel = finish;
    this.#timer = ownerWindow.setTimeout(finish, duration);
    return true;
  }

  #duration(transition: "nativeModalEnterExit" | "adaptiveMenu" = "nativeModalEnterExit"): number {
    const systemReduced =
      this.#ownerWindow?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false;
    return getTransitionDuration(transition, isReducedMotion(this.#readMotion(), systemReduced));
  }

  #cancelMotion(): void {
    if (this.#timer !== undefined) this.#ownerWindow?.clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#animation !== undefined) {
      this.#animation.onfinish = null;
      this.#animation.oncancel = null;
      this.#animation.cancel();
      this.#animation = undefined;
    }
  }
}
