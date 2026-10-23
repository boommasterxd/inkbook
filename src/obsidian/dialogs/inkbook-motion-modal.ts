import { Platform, setIcon, type App } from "obsidian";
import { observeEffectiveMotion, type ObserveMotion } from "../runtime/effective-motion";
import { animateOwnedElement } from "../runtime/element-motion";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";

import {
  getTransitionDuration,
  isReducedMotion,
  type MotionPreference,
} from "../../rendering/motion/transitions";
import { AdaptivePanelSession } from "../menus/panels/adaptive-panel";
import { createPhoneSheetHost, type PhoneSheetHostPort } from "../menus/panels/phone-sheet-host";
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
  readonly #workScheduler: ((ownerWindow: Window | null) => WorkScheduler) | undefined;
  readonly #observeMotion: ObserveMotion | undefined;
  #releasePreference: (() => void) | undefined;
  #phone: AdaptivePanelSession | undefined;
  #animation: ReturnType<typeof animateOwnedElement> | undefined;
  #ownerWindow: Window | null = null;
  #closing = false;
  #hostClosing = false;
  #opened = false;

  public constructor(
    app: App,
    readMotion: () => MotionPreference = () => "system",
    workScheduler?: (ownerWindow: Window | null) => WorkScheduler,
    observeMotion?: ObserveMotion,
  ) {
    this.app = app;
    this.#readMotion = readMotion;
    this.#workScheduler = workScheduler;
    this.#observeMotion = observeMotion;
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
    this.#releasePreference = observeEffectiveMotion(
      this.modalEl,
      this.#readMotion,
      (reduced) => {
        this.modalEl.dataset.inkbookMotion = this.#readMotion();
        if (!reduced) return;
        if (this.#closing) this.closeImmediately();
        else this.#cancelMotion();
      },
      this.#observeMotion,
    );
  }

  public onOpen(): void {
    this.#ownerWindow = this.modalEl.ownerDocument.defaultView;
    if (this.#native !== undefined) {
      this.titleEl.id ||= `inkbook-dialog-title-${crypto.randomUUID()}`;
      this.modalEl.setAttribute("role", "dialog");
      this.modalEl.setAttribute("aria-modal", "true");
      this.modalEl.setAttribute("aria-labelledby", this.titleEl.id);
    }
    this.modalEl.dataset.inkbookMotion = this.#readMotion();
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
    this.#releasePreference?.();
    this.#releasePreference = undefined;
    this.#cancelMotion();
    this.#ownerWindow?.removeEventListener("pagehide", this.#handlePageHide);
    if (this.#native !== undefined) this.#native.closeImmediately();
    else if (this.#phone !== undefined) this.#phone.close("immediate");
    else this.onClose();
  }

  public onClose(): void {
    this.#releasePreference?.();
    this.#releasePreference = undefined;
    this.#cancelMotion();
    this.#ownerWindow?.removeEventListener("pagehide", this.#handlePageHide);
    this.#opened = false;
    this.#phone = undefined;
  }

  #openPhone(): void {
    const ownerDocument = this.modalEl.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    if (ownerWindow === null) throw new Error("Dialogs require an owning window.");
    if (this.#workScheduler === undefined)
      throw new Error("Phone dialogs require a work scheduler.");
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
      workScheduler: this.#workScheduler(ownerWindow),
      anchor,
      canvasInputSurface: anchor,
      createContent: () => content,
      motionAnchor: this.modalEl,
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
    if (ownerWindow === null || duration === 0) {
      this.#cancelMotion();
      return false;
    }
    const computed = exiting ? ownerWindow.getComputedStyle(this.modalEl) : undefined;
    const startScale = computed?.scale;
    const startOpacity = computed?.opacity;
    this.#cancelMotion();
    const finish = (): void => {
      if (exiting) this.closeImmediately();
      else this.#cancelMotion();
    };
    const fromScale = exiting
      ? Number(startScale && startScale !== "none" ? startScale : "1")
      : 0.96;
    const toScale = exiting ? 0.96 : 1;
    const fromOpacity = exiting ? Number(startOpacity || "1") : 0;
    const toOpacity = exiting ? 0 : 1;
    this.#animation = animateOwnedElement(
      this.modalEl,
      { scale: [fromScale, toScale], opacity: [fromOpacity, toOpacity] },
      {
        duration: duration / 1000,
        ease: "easeOut",
        onComplete: finish,
      },
    );
    return true;
  }

  #duration(transition: "nativeModalEnterExit" | "adaptiveMenu" = "nativeModalEnterExit"): number {
    const systemReduced =
      this.#ownerWindow?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false;
    return getTransitionDuration(transition, isReducedMotion(this.#readMotion(), systemReduced));
  }

  #cancelMotion(): void {
    if (this.#animation !== undefined) {
      this.#animation.stop();
      this.#animation = undefined;
    }
    this.modalEl.style.removeProperty("scale");
    this.modalEl.style.removeProperty("opacity");
  }
}
