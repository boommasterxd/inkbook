import { Component, Platform, Scope, type Keymap } from "obsidian";

import { effectiveTransitionDuration } from "../runtime/effective-motion";
import { registerFocusNavigation } from "../runtime/focus-navigation";
import { menuDomWindow } from "./menu-dom";
import type { FocusTargetPort } from "./menu-ports";
import { PhoneSheetSwipeController } from "./phone-sheet-swipe";

const DESKTOP_GAP_PX = 4;
const TABLET_GAP_PX = 2;
const DESKTOP_VIEWPORT_INSET_PX = 8;

export type AdaptivePanelCloseMode = "animated" | "handoff" | "immediate";
type AdaptivePanelKind = "background" | "style";

export interface AdaptivePanelContentLifecycle {
  prepareLayoutChange(): void;
  requestLayout(): void;
}

export interface AdaptivePanelOptions {
  readonly anchor: HTMLElement;
  readonly canvasInputSurface: FocusTargetPort;
  readonly createContent: (lifecycle: AdaptivePanelContentLifecycle) => DocumentFragment;
  readonly keymap?: Pick<Keymap, "popScope" | "pushScope">;
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
  #layoutFrame: number | undefined;
  #layoutRequested = false;
  #layoutStartHeight: number | undefined;
  #layoutTimer: number | undefined;
  readonly #layer: HTMLElement;
  readonly #options: AdaptivePanelOptions;
  readonly #phoneSwipe: PhoneSheetSwipeController | undefined;
  #openFrame: number | undefined;
  #presenceTimer: number | undefined;
  #removeTimer: number | undefined;
  #returnedFocus = false;
  #restoreFocus = true;
  readonly #scope: Scope;
  readonly #scroll: HTMLElement;
  readonly #surface: HTMLElement;

  public constructor(options: AdaptivePanelOptions) {
    super();
    this.#options = options;
    this.#durationMs = effectiveTransitionDuration(
      options.anchor,
      options.ownerWindow,
      "adaptiveMenu",
    );
    this.#layer = menuDomWindow(options.ownerDocument, "adaptive panel").createDiv();
    this.#layer.className = "inkbook-adaptive-panel-layer";
    this.#layer.dataset.platform = Platform.isPhone ? "phone" : "wide";
    this.#layer.dataset.mobile = Platform.isMobile ? "true" : "false";
    this.#backdrop = this.#layer.createDiv({ cls: "inkbook-adaptive-panel-backdrop" });
    this.#surface = this.#layer.createEl("section", { cls: "inkbook-adaptive-panel" });
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
    this.#createGrabber();
    this.#scroll = this.#surface.createDiv({ cls: "inkbook-adaptive-panel-scroll" });
    this.#createHeader();
    this.#content = this.#scroll.createDiv({ cls: "inkbook-adaptive-panel-content" });
    this.#content.append(
      options.createContent({
        prepareLayoutChange: () => this.prepareLayoutChange(),
        requestLayout: () => this.requestLayout(),
      }),
    );
    this.#layer.append(this.#backdrop, this.#surface);
    this.#phoneSwipe = Platform.isPhone
      ? new PhoneSheetSwipeController({
          backdrop: this.#backdrop,
          close: () => this.close(),
          durationMs: this.#durationMs,
          ownerWindow: options.ownerWindow,
          scroll: this.#scroll,
          surface: this.#surface,
        })
      : undefined;
    this.#scope = this.#createScope();
    options.ownerDocument.body.append(this.#layer);
    this.load();
  }

  public close(mode: AdaptivePanelCloseMode = "animated"): void {
    if (this.#closed) return;
    this.#closed = true;
    delete this.#surface.dataset.presence;
    this.#phoneSwipe?.prepareClose();
    this.#restoreFocus = mode !== "handoff";
    if (mode !== "animated" || this.#durationMs === 0 || !Platform.isPhone) {
      this.#finishClose();
      return;
    }
    this.#surface.inert = true;
    this.#surface.setAttribute("aria-hidden", "true");
    const activeElement = this.#options.ownerDocument.activeElement;
    if (activeElement !== null && "blur" in activeElement) (activeElement as HTMLElement).blur();
    if (this.#restoreFocus) this.#returnFocus();
    this.#surface.dataset.state = "closing";
    this.#backdrop.dataset.state = "closing";
    this.#removeTimer = this.#options.ownerWindow.setTimeout(
      () => this.#finishClose(),
      this.#durationMs,
    );
  }

  public override onload(): void {
    this.register(
      registerFocusNavigation(
        this.#layer,
        this.#options.anchor.closest('[data-inkbook-keyboard-navigation="true"]') !== null,
      ),
    );
    this.#registerEvents();
    this.#registerViewportEvents();
    this.#options.keymap?.pushScope(this.#scope);
    this.register(() => this.#options.keymap?.popScope(this.#scope));
    this.register(() => this.#cancelScheduledWork());
    this.#position();
    this.#observeContentSize();
    this.#openFrame = this.#options.ownerWindow.requestAnimationFrame(() => {
      this.#openFrame = undefined;
      if (this.#closed) return;
      this.#surface.dataset.state = "open";
      (this.#focusableElements()[0] ?? this.#surface).focus({ preventScroll: true });
      if (this.#durationMs === 0) {
        delete this.#surface.dataset.presence;
        return;
      }
      this.#presenceTimer = this.#options.ownerWindow.setTimeout(() => {
        this.#presenceTimer = undefined;
        delete this.#surface.dataset.presence;
      }, this.#durationMs);
    });
  }

  public prepareLayoutChange(): void {
    if (this.#closed || this.#layoutStartHeight !== undefined) return;
    const height = this.#scroll.getBoundingClientRect().height;
    if (height > 0) this.#layoutStartHeight = height;
  }

  public requestLayout(): void {
    this.#layoutRequested = true;
    this.#scheduleLayout();
  }

  #requestPosition(): void {
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
      this.#position();
    });
  }

  #animateContentHeight(startHeight: number | undefined): void {
    if (this.#durationMs === 0 || this.#surface.dataset.state !== "open") return;
    const current = startHeight ?? this.#scroll.getBoundingClientRect().height;
    const target = Math.min(this.#scroll.scrollHeight, this.#maximumScrollHeight());
    if (current <= 0 || target <= 0 || Math.abs(current - target) < 1) return;
    this.#scroll.style.setProperty("block-size", `${String(current)}px`);
    this.#scroll.getBoundingClientRect();
    this.#scroll.style.setProperty("block-size", `${String(target)}px`);
    const reset = (): void => {
      this.#scroll.style.removeProperty("block-size");
    };
    if (this.#layoutTimer !== undefined) this.#options.ownerWindow.clearTimeout(this.#layoutTimer);
    this.#layoutTimer = this.#options.ownerWindow.setTimeout(() => {
      this.#layoutTimer = undefined;
      reset();
    }, this.#durationMs);
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
    if (this.#layoutTimer !== undefined) {
      this.#options.ownerWindow.clearTimeout(this.#layoutTimer);
      this.#layoutTimer = undefined;
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

  #createScope(): Scope {
    const scope = new Scope();
    scope.register([], "Escape", () => {
      this.close();
      return false;
    });
    return scope;
  }

  #finishClose(): void {
    this.#cancelScheduledWork();
    this.unload();
    this.#layer.remove();
    if (this.#restoreFocus) this.#returnFocus();
    this.#options.onClosed();
  }

  #handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close();
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
    const target = event.target;
    if (!isNode(target)) return;
    if (this.#surface.contains(target) || this.#options.anchor.contains(target)) return;
    this.close();
  };

  #focusableElements(): HTMLElement[] {
    return [...this.#surface.querySelectorAll<HTMLElement>(focusableSelector())].filter(
      (element) => !element.hasAttribute("disabled") && element.tabIndex !== -1,
    );
  }

  #maximumScrollHeight(): number {
    const viewport = this.#visualViewport();
    return Platform.isPhone
      ? viewport.height * 0.6
      : Math.max(0, viewport.height - DESKTOP_VIEWPORT_INSET_PX * 2);
  }

  #observeContentSize(): void {
    const resizeObserverConstructor = (
      this.#options.ownerWindow as Window & { readonly ResizeObserver?: typeof ResizeObserver }
    ).ResizeObserver;
    if (resizeObserverConstructor === undefined) return;
    const observer = new resizeObserverConstructor(() => this.requestLayout());
    observer.observe(this.#content);
    this.register(() => observer.disconnect());
  }

  #position(): void {
    const viewport = this.#visualViewport();
    this.#layer.style.setProperty(
      "--inkbook-adaptive-panel-viewport-top",
      `${String(viewport.top)}px`,
    );
    this.#layer.style.setProperty(
      "--inkbook-adaptive-panel-viewport-height",
      `${String(viewport.height)}px`,
    );
    this.#layer.style.setProperty(
      "--inkbook-adaptive-panel-viewport-left",
      `${String(viewport.left)}px`,
    );
    this.#layer.style.setProperty(
      "--inkbook-adaptive-panel-viewport-width",
      `${String(viewport.width)}px`,
    );
    if (Platform.isPhone) return;
    const anchor = this.#options.anchor.getBoundingClientRect();
    const panel = this.#surface.getBoundingClientRect();
    const maxLeft = viewport.left + viewport.width - panel.width - DESKTOP_VIEWPORT_INSET_PX;
    const left = clamp(
      anchor.left + anchor.width / 2 - panel.width / 2,
      viewport.left + DESKTOP_VIEWPORT_INSET_PX,
      maxLeft,
    );
    const panelGap = Platform.isMobile ? TABLET_GAP_PX : DESKTOP_GAP_PX;
    const below = anchor.bottom + panelGap;
    const above = anchor.top - panelGap - panel.height;
    const top =
      below + panel.height <= viewport.top + viewport.height - DESKTOP_VIEWPORT_INSET_PX
        ? below
        : Math.max(viewport.top + DESKTOP_VIEWPORT_INSET_PX, above);
    this.#surface.style.setProperty("inset-inline-start", `${String(left)}px`);
    this.#surface.style.setProperty("inset-block-start", `${String(top)}px`);
  }

  #registerEvents(): void {
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
    const reposition = (): void => this.#requestPosition();
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
    const anchor = this.#options.anchor;
    if (anchor.isConnected && anchor.ownerDocument === this.#options.ownerDocument) {
      anchor.focus({ preventScroll: true });
      return;
    }
    this.#options.canvasInputSurface.focus({ preventScroll: true });
  }

  #visualViewport(): {
    readonly height: number;
    readonly left: number;
    readonly top: number;
    readonly width: number;
  } {
    const viewport = this.#options.ownerWindow.visualViewport;
    if (viewport !== undefined && viewport !== null) {
      return {
        height: viewport.height,
        left: viewport.offsetLeft,
        top: viewport.offsetTop,
        width: viewport.width,
      };
    }
    return {
      height: this.#options.ownerWindow.innerHeight,
      left: 0,
      top: 0,
      width: this.#options.ownerWindow.innerWidth,
    };
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function focusableSelector(): string {
  return "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
}

function isNode(target: EventTarget | null): target is Node {
  return target !== null && "nodeType" in target;
}
