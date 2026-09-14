import { Component, Platform, type Keymap } from "obsidian";
import { installMenuEscapeScope } from "./menu-escape-scope";

import { effectiveTransitionDuration } from "../runtime/effective-motion";
import { registerFocusNavigation } from "../runtime/focus-navigation";
import { readMenuViewport } from "./menu-viewport";
import { revealPhoneSheetEditable } from "./phone-sheet-editable";
import { menuDomWindow } from "./menu-dom";
import type { FocusTargetPort } from "./menu-ports";
import type { PhoneSheetHostPort } from "./phone-sheet-host";
import { trapPhoneSheetFocus } from "./phone-sheet-focus";
import { PhoneSheetSwipeController } from "./phone-sheet-swipe";
import { prepareWideMenuExit } from "./wide-menu-motion";

import { AdaptivePanelHeight } from "./adaptive-panel-height";
import { AdaptivePanelPlacement } from "./adaptive-panel-placement";
import { PhoneSheetPages } from "./phone-sheet-pages";
import type { AdaptivePanelContentLifecycle, PhoneSheetNavigation } from "./panel-page";
export type { AdaptivePanelContentLifecycle } from "./panel-page";

export type AdaptivePanelCloseMode = "animated" | "handoff" | "immediate";
type AdaptivePanelKind = "background" | "style" | "dialog" | "menu";

export interface AdaptivePanelOptions {
  readonly anchor: HTMLElement;
  readonly phoneHost?: PhoneSheetHostPort;
  readonly createPhoneSheetHost?: () => PhoneSheetHostPort;
  readonly canvasInputSurface: FocusTargetPort;
  readonly createContent: (lifecycle: AdaptivePanelContentLifecycle) => DocumentFragment;
  readonly keymap?: Pick<Keymap, "popScope" | "pushScope">;
  readonly durationMs?: number;
  readonly entryDurationMs?: number;
  readonly initialFocus?: HTMLElement;
  readonly restoreFocus?: boolean;
  readonly onClosing?: () => void;
  readonly kind: AdaptivePanelKind;
  readonly label: string;
  readonly onBack?: () => void;
  readonly onClosed: () => void;
  readonly ownerDocument: Document;
  readonly ownerWindow: Window;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
}

export class AdaptivePanelSession extends Component {
  readonly #backdrop: HTMLElement;
  #closed = false;
  readonly #content: HTMLElement;
  readonly #durationMs: number;
  readonly #entryDurationMs: number;
  #contentObserver: ResizeObserver | undefined;
  #layoutFrame: number | undefined;
  #layoutRequested = false;
  #revealEditable = false;
  #layoutStartHeight: number | undefined;
  readonly #height: AdaptivePanelHeight;
  #positionRequested = false;
  readonly #layer: HTMLElement;
  readonly #options: AdaptivePanelOptions;
  readonly #placement: AdaptivePanelPlacement;
  readonly #pages: PhoneSheetPages | undefined;
  readonly #phoneHost: PhoneSheetHostPort | undefined;
  readonly #phoneSwipe: PhoneSheetSwipeController | undefined;
  #openFrame: number | undefined;
  #presenceTimer: number | undefined;
  #removeTimer: number | undefined;
  #returnedFocus = false;
  #restoreFocus = true;
  readonly #scroll: HTMLElement;
  readonly #surface: HTMLElement;

  public constructor(options: AdaptivePanelOptions) {
    super();
    this.#options = options;
    this.#phoneHost = Platform.isPhone
      ? (options.phoneHost ?? options.createPhoneSheetHost?.())
      : undefined;
    this.#durationMs =
      options.durationMs ??
      effectiveTransitionDuration(options.anchor, options.ownerWindow, "adaptiveMenu");
    this.#entryDurationMs =
      options.entryDurationMs ??
      (Platform.isPhone
        ? this.#durationMs
        : effectiveTransitionDuration(options.anchor, options.ownerWindow, "nativeModalEnterExit"));
    this.#layer =
      this.#phoneHost?.containerEl ??
      menuDomWindow(options.ownerDocument, "adaptive panel").createDiv();
    this.#layer.classList.add("inkbook-adaptive-panel-layer");
    this.#layer.dataset.kind = options.kind;
    this.#layer.dataset.platform = Platform.isPhone ? "phone" : "wide";
    this.#layer.dataset.mobile = Platform.isMobile ? "true" : "false";
    this.#backdrop = this.#layer.createDiv({ cls: "inkbook-adaptive-panel-backdrop" });
    this.#surface = this.#phoneHost?.modalEl ?? this.#layer.createEl("section");
    this.#surface.classList.add("inkbook-adaptive-panel");
    this.#surface.dataset.kind = options.kind;
    this.#surface.dataset.presence = "entering";
    this.#surface.dataset.state = "opening";
    this.#surface.setAttribute("aria-label", options.label);
    this.#surface.setAttribute("role", "dialog");
    this.#surface.tabIndex = -1;
    if (Platform.isPhone) this.#surface.setAttribute("aria-modal", "true");
    this.#surface.style.setProperty(
      "--inkbook-adaptive-panel-duration",
      `${String(this.#durationMs)}ms`,
    );
    this.#surface.style.setProperty(
      "--inkbook-adaptive-panel-entry-duration",
      `${String(this.#entryDurationMs)}ms`,
    );
    this.#placement = new AdaptivePanelPlacement({
      anchor: options.anchor,
      layer: this.#layer,
      surface: this.#surface,
      ownerWindow: options.ownerWindow,
    });
    this.#createGrabber();
    this.#scroll = this.#surface.createDiv({ cls: "inkbook-adaptive-panel-scroll" });
    this.#height = this.#createHeight();
    this.#createHeader();
    this.#content = this.#scroll.createDiv({ cls: "inkbook-adaptive-panel-content" });
    this.#content.append(
      options.createContent({
        prepareLayoutChange: () => this.prepareLayoutChange(),
        requestLayout: () => this.requestLayout(),
      }),
    );
    this.#pages = Platform.isPhone
      ? new PhoneSheetPages({
          scroll: this.#scroll,
          rootContent: this.#content,
          observeContent: (content) => {
            this.#contentObserver?.disconnect();
            this.#contentObserver?.observe(content);
          },
          surface: this.#surface,
          layer: this.#layer,
          lifecycle: {
            prepareLayoutChange: () => this.prepareLayoutChange(),
            requestLayout: () => this.requestLayout(),
          },
          position: () => this.#position(),
          renderIcon: options.renderIcon,
          height: this.#height,
          close: (mode) => this.close(mode),
        })
      : undefined;
    this.#layer.append(this.#backdrop, this.#surface);
    this.#phoneSwipe = Platform.isPhone
      ? new PhoneSheetSwipeController({
          onDragStart: () => this.#height.pause(),
          onDragCancel: () => this.#height.resume(),
          backdrop: this.#backdrop,
          close: () => this.close(),
          durationMs: this.#durationMs,
          ownerWindow: options.ownerWindow,
          scroll: this.#scroll,
          surface: this.#surface,
        })
      : undefined;
    if (this.#phoneHost !== undefined) this.#phoneHost.open(() => this.#backOrClose());
    else options.ownerDocument.body.append(this.#layer);
    this.load();
  }

  public get navigation(): PhoneSheetNavigation | undefined {
    return this.#pages;
  }

  #createHeight(): AdaptivePanelHeight {
    return new AdaptivePanelHeight({
      scroll: this.#scroll,
      surface: this.#surface,
      ownerWindow: this.#options.ownerWindow,
      maximumHeight: () => this.#placement.maximumScrollHeight(),
      durationMs: this.#durationMs,
      pageDurationMs: effectiveTransitionDuration(
        this.#options.anchor,
        this.#options.ownerWindow,
        "adaptivePage",
      ),
    });
  }

  #backOrClose(): void {
    if (!this.#pages?.back()) this.close();
  }

  public close(mode: AdaptivePanelCloseMode = "animated"): void {
    if (this.#closed) {
      if (mode !== "animated" && this.#removeTimer !== undefined) this.#finishClose();
      return;
    }
    this.#closed = true;
    this.#height.dispose();
    this.#pages?.dispose();
    this.#options.onClosing?.();
    this.#phoneSwipe?.prepareClose();
    const closeDuration = Platform.isPhone ? this.#durationMs : this.#entryDurationMs;
    if (!Platform.isPhone && mode === "animated" && closeDuration > 0)
      prepareWideMenuExit(this.#surface, this.#options.ownerWindow);
    delete this.#surface.dataset.presence;
    this.#restoreFocus = mode !== "handoff";
    if (mode !== "animated" || closeDuration === 0) {
      this.#finishClose();
      return;
    }
    this.#surface.inert = true;
    this.#surface.setAttribute("aria-hidden", "true");
    const activeElement = this.#options.ownerDocument.activeElement;
    if (activeElement !== null && "blur" in activeElement) (activeElement as HTMLElement).blur();
    if (this.#restoreFocus && this.#options.restoreFocus !== false) this.#returnFocus();
    this.#surface.dataset.state = "closing";
    this.#backdrop.dataset.state = "closing";
    this.#removeTimer = this.#options.ownerWindow.setTimeout(
      () => this.#finishClose(),
      closeDuration,
    );
  }

  public override onload(): void {
    this.register(
      registerFocusNavigation(
        this.#layer,
        !Platform.isPhone &&
          this.#options.anchor.closest('[data-inkbook-keyboard-navigation="true"]') !== null,
      ),
    );
    this.#registerEvents();
    this.#registerViewportEvents();
    if (this.#phoneHost === undefined) {
      this.register(installMenuEscapeScope(this.#options.keymap, () => this.#backOrClose()));
    }
    this.register(() => this.#cancelScheduledWork());
    this.register(() => this.#pages?.dispose());
    this.register(() => this.#height.dispose());
    this.#position();
    this.#observeContentSize();
    this.#openFrame = this.#options.ownerWindow.requestAnimationFrame(() => {
      this.#openFrame = undefined;
      if (this.#closed) return;
      this.#surface.dataset.state = "open";
      (this.#options.initialFocus ?? this.#focusableElements()[0] ?? this.#surface).focus({
        preventScroll: true,
      });
      if (this.#entryDurationMs === 0) {
        delete this.#surface.dataset.presence;
        this.#pages?.finishEntry();
        return;
      }
      this.#presenceTimer = this.#options.ownerWindow.setTimeout(() => {
        this.#presenceTimer = undefined;
        delete this.#surface.dataset.presence;
        this.#pages?.finishEntry();
      }, this.#entryDurationMs);
    });
  }

  public prepareLayoutChange(): void {
    if (this.#closed || this.#layoutStartHeight !== undefined || this.#isPhoneDialog()) return;
    const height = Platform.isPhone
      ? this.#scroll.getBoundingClientRect().height
      : this.#scroll.offsetHeight;
    if (height > 0) this.#layoutStartHeight = height;
  }

  public requestLayout(): void {
    if (this.#isPhoneDialog()) return;
    this.#layoutRequested = true;
    this.#scheduleLayout();
  }

  #isPhoneDialog(): boolean {
    return Platform.isPhone && this.#surface.dataset.kind === "dialog";
  }

  #requestPosition(revealEditable = false): void {
    this.#positionRequested = true;
    this.#revealEditable ||= revealEditable;
    this.#scheduleLayout();
  }

  #scheduleLayout(): void {
    if (this.#closed || this.#layoutFrame !== undefined) return;
    this.#layoutFrame = this.#options.ownerWindow.requestAnimationFrame(() => {
      this.#layoutFrame = undefined;
      if (this.#layoutRequested) {
        this.#layoutRequested = false;
        const startHeight = this.#layoutStartHeight;
        this.#layoutStartHeight = undefined;
        this.#animateContentHeight(startHeight);
      }
      if (!Platform.isPhone || this.#positionRequested) this.#position();
      this.#positionRequested = false;
      if (this.#revealEditable && Platform.isPhone && this.#isTopmostLayer()) {
        revealPhoneSheetEditable(this.#scroll, readMenuViewport(this.#options.ownerWindow));
      }
      this.#revealEditable = false;
    });
  }

  #animateContentHeight(startHeight: number | undefined): void {
    if (
      this.#surface.dataset.kind === "dialog" ||
      this.#height.pageTransitioning ||
      this.#height.paused ||
      this.#durationMs === 0 ||
      this.#surface.dataset.state !== "open" ||
      (Platform.isPhone && this.#surface.dataset.presence === "entering")
    )
      return;
    const current =
      startHeight ??
      (Platform.isPhone ? this.#scroll.getBoundingClientRect().height : this.#scroll.offsetHeight);
    this.#height.animate(current);
  }

  #cancelScheduledWork(): void {
    if (this.#openFrame !== undefined) {
      this.#options.ownerWindow.cancelAnimationFrame(this.#openFrame);
      this.#openFrame = undefined;
    }
    if (this.#layoutFrame !== undefined) {
      this.#options.ownerWindow.cancelAnimationFrame(this.#layoutFrame);
      this.#layoutFrame = undefined;
    }
    if (this.#removeTimer !== undefined) {
      this.#options.ownerWindow.clearTimeout(this.#removeTimer);
      this.#removeTimer = undefined;
    }
    if (this.#presenceTimer !== undefined) {
      this.#options.ownerWindow.clearTimeout(this.#presenceTimer);
      this.#presenceTimer = undefined;
    }
    this.#layoutStartHeight = undefined;
    this.#layoutRequested = false;
  }

  #createGrabber(): void {
    const region = this.#surface.createDiv({ cls: "inkbook-adaptive-panel-drag-region" });
    const grabber = region.createDiv({ cls: "inkbook-adaptive-panel-grabber" });
    region.setAttribute("aria-hidden", "true");
    grabber.setAttribute("aria-hidden", "true");
  }

  #createHeader(): void {
    if (this.#options.onBack === undefined) return;
    const header = this.#scroll.createDiv({ cls: "inkbook-adaptive-panel-header" });
    const back = header.createDiv({ cls: "inkbook-adaptive-panel-back" });
    back.tabIndex = 0;
    back.setAttribute("role", "button");
    back.setAttribute("aria-label", "Back to more options");
    const icon = back.createSpan({ cls: "inkbook-adaptive-panel-back-icon" });
    this.#options.renderIcon(icon, "arrow-left");
    back.createSpan({ text: "Back" });
    const activate = (): void => this.#options.onBack?.();
    back.addEventListener("click", activate);
    back.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      activate();
    });
  }

  #finishClose(): void {
    this.#cancelScheduledWork();
    this.unload();
    this.#phoneHost?.close();
    this.#layer.remove();
    if (this.#restoreFocus && this.#options.restoreFocus !== false) this.#returnFocus();
    this.#options.onClosed();
  }

  #handleKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || !this.#isTopmostLayer()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.#backOrClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = this.#focusableElements();
    if (focusable.length === 0) return;
    const current = this.#options.ownerDocument.activeElement;
    const index = focusable.indexOf(current as HTMLElement);
    const next = event.shiftKey
      ? focusable[(index <= 0 ? focusable.length : index) - 1]
      : focusable[(index + 1) % focusable.length];
    event.preventDefault();
    next?.focus({ preventScroll: true });
  };

  #handleOutsidePointer = (event: PointerEvent): void => {
    if (!this.#isTopmostLayer()) return;
    const target = event.target;
    if (!isNode(target)) return;
    if (this.#surface.contains(target) || this.#options.anchor.contains(target)) return;
    this.close();
  };

  #isTopmostLayer(): boolean {
    const layers = this.#options.ownerDocument.querySelectorAll(".inkbook-adaptive-panel-layer");
    return !this.#closed && layers.item(layers.length - 1) === this.#layer;
  }

  #focusableElements(): HTMLElement[] {
    return [...this.#surface.querySelectorAll<HTMLElement>(focusableSelector())].filter(
      (element) =>
        !element.hasAttribute("disabled") &&
        element.tabIndex !== -1 &&
        element.closest("[hidden], [inert]") === null,
    );
  }

  #observeContentSize(): void {
    const resizeObserverConstructor = (
      this.#options.ownerWindow as Window & { readonly ResizeObserver?: typeof ResizeObserver }
    ).ResizeObserver;
    if (resizeObserverConstructor === undefined) return;
    const observer = new resizeObserverConstructor(() => this.requestLayout());
    this.#contentObserver = observer;
    observer.observe(this.#content);
    this.register(() => observer.disconnect());
  }

  #position(): void {
    this.#placement.position();
  }

  #registerEvents(): void {
    if (Platform.isPhone) {
      this.register(
        trapPhoneSheetFocus(this.#surface, this.#options.initialFocus ?? this.#surface, () =>
          this.#isTopmostLayer(),
        ),
      );
    }
    this.registerDomEvent(this.#options.ownerDocument, "keydown", this.#handleKeyDown, true);
    this.registerDomEvent(
      this.#options.ownerDocument,
      "pointerdown",
      this.#handleOutsidePointer,
      true,
    );
    const swipe = this.#phoneSwipe;
    if (swipe === undefined) return;
    this.registerDomEvent(this.#surface, "pointerdown", swipe.handlePointerDown);
    this.registerDomEvent(this.#surface, "pointermove", swipe.handlePointerMove);
    this.registerDomEvent(this.#surface, "pointerup", swipe.handlePointerUp);
    this.registerDomEvent(this.#surface, "pointercancel", swipe.handlePointerCancel);
    this.registerDomEvent(this.#surface, "lostpointercapture", swipe.handleLostPointerCapture);
    this.registerDomEvent(this.#scroll, "scroll", swipe.syncScrollPosition);
    this.register(() => swipe.dispose());
  }

  #registerViewportEvents(): void {
    const reposition = (): void => this.#requestPosition(true);
    const repositionForDocumentScroll = (event: Event): void => {
      const target = event.target;
      if (isNode(target) && this.#surface.contains(target)) return;
      this.#requestPosition();
    };
    this.registerDomEvent(this.#options.ownerWindow, "resize", reposition);
    this.registerDomEvent(this.#options.ownerDocument, "scroll", repositionForDocumentScroll, true);
    const visualViewport = this.#options.ownerWindow.visualViewport;
    if (visualViewport === undefined || visualViewport === null) return;
    visualViewport.addEventListener("resize", reposition);
    visualViewport.addEventListener("scroll", reposition);
    this.register(() => {
      visualViewport.removeEventListener("resize", reposition);
      visualViewport.removeEventListener("scroll", reposition);
    });
  }

  #returnFocus(): void {
    if (this.#returnedFocus) return;
    this.#returnedFocus = true;
    const { anchor, canvasInputSurface, ownerDocument } = this.#options;
    const target =
      anchor.isConnected && anchor.ownerDocument === ownerDocument ? anchor : canvasInputSurface;
    target.focus({ preventScroll: true });
  }
}

function focusableSelector(): string {
  return "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
}

function isNode(target: EventTarget | null): target is Node {
  return target !== null && "nodeType" in target;
}
