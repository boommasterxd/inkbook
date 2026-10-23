import { Component, Platform, type Keymap } from "obsidian";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { installMenuEscapeScope } from "../menu-escape-scope";

import { effectiveTransitionDuration } from "../../runtime/effective-motion";
import { registerFocusNavigation } from "../../runtime/focus-navigation";
import { revealPhoneSheetEditable } from "./phone-sheet-editable";
import { menuDomWindow } from "../menu-dom";
import type { FocusTargetPort } from "../menu-ports";
import type { PhoneSheetHostPort } from "./phone-sheet-host";
import { PhoneSheetSwipeController } from "./phone-sheet-swipe";
import { animateWideMenuEntry, animateWideMenuExit } from "../feedback/wide-menu-motion";
import { observeMenuMotionPreference, playMenuMotion } from "../feedback/menu-motion";
import { registerMenuFeedback } from "../feedback/menu-feedback";

import { AdaptivePanelLayout } from "./adaptive-panel-layout";
import { createAdaptivePanelHeader } from "./adaptive-panel-header";
import { registerPanelInteraction, registerPanelViewport } from "./adaptive-panel-interaction";
import { AdaptivePanelPlacement } from "./adaptive-panel-placement";
import { PhoneSheetPages } from "./phone-sheet-pages";
import type { AdaptivePanelContentLifecycle, PhoneSheetNavigation } from "./panel-page";
import { animatePhoneSheetExit } from "./phone-sheet-motion";
export type { AdaptivePanelContentLifecycle } from "./panel-page";

export type AdaptivePanelCloseMode = "animated" | "handoff" | "immediate";
type AdaptivePanelKind = "background" | "style" | "dialog" | "menu";

export interface AdaptivePanelOptions {
  readonly workScheduler: WorkScheduler;
  readonly anchor: HTMLElement;
  readonly motionAnchor?: HTMLElement;
  readonly dismissOnAnchorPointer?: boolean;
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
  #revealEditable = false;
  readonly #layout: AdaptivePanelLayout;
  #positionRequested = false;
  readonly #layer: HTMLElement;
  readonly #options: AdaptivePanelOptions;
  readonly #motionAnchor: HTMLElement;
  readonly #placement: AdaptivePanelPlacement;
  readonly #pages: PhoneSheetPages | undefined;
  readonly #phoneHost: PhoneSheetHostPort | undefined;
  readonly #phoneSwipe: PhoneSheetSwipeController | undefined;
  #openFrame: number | undefined;
  #entryStop: (() => void) | undefined;
  #exitStop: (() => void) | undefined;
  #feedbackStop: (() => void) | undefined;
  #returnedFocus = false;
  #restoreFocus = true;
  readonly #scroll: HTMLElement;
  readonly #surface: HTMLElement;

  public constructor(options: AdaptivePanelOptions) {
    super();
    this.#options = options;
    this.#motionAnchor = options.motionAnchor ?? options.anchor;
    this.#phoneHost = Platform.isPhone
      ? (options.phoneHost ?? options.createPhoneSheetHost?.())
      : undefined;
    this.#durationMs =
      options.durationMs ??
      effectiveTransitionDuration(this.#motionAnchor, options.ownerWindow, "adaptiveMenu");
    this.#entryDurationMs =
      options.entryDurationMs ??
      (Platform.isPhone
        ? this.#durationMs
        : effectiveTransitionDuration(
            this.#motionAnchor,
            options.ownerWindow,
            "nativeModalEnterExit",
          ));
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
    this.#layer.style.setProperty(
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
    const grabber = this.#createGrabber();
    this.#scroll = menuDomWindow(options.ownerDocument, "adaptive panel").createDiv({
      cls: "inkbook-adaptive-panel-scroll",
    });
    this.#layout = new AdaptivePanelLayout(this.#surface, grabber, this.#scroll);
    if (options.onBack !== undefined)
      createAdaptivePanelHeader(this.#scroll, options.onBack, options.renderIcon);
    this.#content = this.#scroll.createDiv({ cls: "inkbook-adaptive-panel-content" });
    this.#content.append(
      options.createContent({
        mutateLayout: (update) => this.mutateLayout(update),
      }),
    );
    this.#pages = this.#createPages(options);
    this.#layer.append(this.#backdrop, this.#surface);
    this.#phoneSwipe = Platform.isPhone
      ? new PhoneSheetSwipeController({
          onDragStart: () => {
            this.#entryStop?.();
            this.#entryStop = undefined;
            this.#pages?.finishMotion();
          },
          backdrop: this.#backdrop,
          close: () => this.close(),
          durationMs: () => this.#panelDuration(),
          ownerWindow: options.ownerWindow,
          workScheduler: options.workScheduler,
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

  #createPages(options: AdaptivePanelOptions): PhoneSheetPages | undefined {
    if (!Platform.isPhone) return undefined;
    return new PhoneSheetPages({
      scroll: this.#scroll,
      rootContent: this.#content,
      observeContent: (content) => {
        this.#contentObserver?.disconnect();
        this.#contentObserver?.observe(content);
      },
      refreshFeedback: () => this.#refreshFeedback(),
      surface: this.#surface,
      layer: this.#layer,
      lifecycle: { mutateLayout: (update) => this.mutateLayout(update) },
      position: () => this.#position(),
      renderIcon: options.renderIcon,
      layout: this.#layout,
      durationMs: () => this.#panelDuration(),
      pageDurationMs: () =>
        effectiveTransitionDuration(this.#motionAnchor, options.ownerWindow, "adaptivePage"),
      close: (mode) => this.close(mode),
    });
  }

  #panelDuration(): number {
    const effective = effectiveTransitionDuration(
      this.#motionAnchor,
      this.#options.ownerWindow,
      "adaptiveMenu",
    );
    return effective === 0 ? 0 : (this.#options.durationMs ?? effective);
  }

  #entryDuration(): number {
    const effective = effectiveTransitionDuration(
      this.#motionAnchor,
      this.#options.ownerWindow,
      Platform.isPhone ? "adaptiveMenu" : "nativeModalEnterExit",
    );
    return this.#panelDuration() === 0 ? 0 : (this.#options.entryDurationMs ?? effective);
  }

  #backOrClose(): void {
    if (!this.#pages?.back()) this.close();
  }

  public close(mode: AdaptivePanelCloseMode = "animated"): void {
    if (this.#closed) {
      if (mode !== "animated" && this.#exitStop !== undefined) this.#finishClose();
      return;
    }
    this.#closed = true;
    this.#pages?.dispose();
    this.#options.onClosing?.();
    this.#phoneSwipe?.prepareClose();
    const closeDuration = Platform.isPhone ? this.#panelDuration() : this.#entryDuration();
    if (Platform.isPhone || mode !== "animated" || closeDuration === 0) {
      this.#entryStop?.();
      this.#entryStop = undefined;
    }
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
    this.#exitStop = Platform.isPhone
      ? animatePhoneSheetExit(
          this.#surface,
          this.#backdrop,
          this.#options.ownerWindow,
          closeDuration,
          () => this.#finishClose(),
        )
      : animateWideMenuExit(this.#surface, this.#options.ownerWindow, closeDuration, () =>
          this.#finishClose(),
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
    registerPanelInteraction({
      owner: this,
      ownerDocument: this.#options.ownerDocument,
      surface: this.#surface,
      scroll: this.#scroll,
      anchor: this.#options.anchor,
      ...(this.#options.initialFocus === undefined
        ? {}
        : { initialFocus: this.#options.initialFocus }),
      dismissOnAnchorPointer: this.#options.dismissOnAnchorPointer === true,
      ...(this.#phoneSwipe === undefined ? {} : { swipe: this.#phoneSwipe }),
      topmost: () => this.#isTopmostLayer(),
      focusable: () => this.#focusableElements(),
      backOrClose: () => this.#backOrClose(),
      close: () => this.close(),
    });
    registerPanelViewport({
      owner: this,
      ownerWindow: this.#options.ownerWindow,
      ownerDocument: this.#options.ownerDocument,
      surface: this.#surface,
      placement: this.#placement,
      reposition: (reveal) => this.#requestPosition(reveal),
    });
    if (this.#phoneHost === undefined) {
      this.register(installMenuEscapeScope(this.#options.keymap, () => this.#backOrClose()));
    }
    this.register(() => this.#cancelScheduledWork());
    this.#refreshFeedback();
    this.register(() => this.#feedbackStop?.());
    this.register(
      observeMenuMotionPreference(this.#motionAnchor, this.#options.ownerWindow, () => {
        this.#layout.finish();
        this.#phoneSwipe?.finishMotion();
        this.#pages?.finishMotion();
        if (this.#closed) {
          if (this.#exitStop !== undefined) this.#finishClose();
          return;
        }
        if (this.#surface.dataset.presence === "entering") {
          this.#entryStop?.();
          this.#entryStop = undefined;
          playMenuMotion(this.#surface, { opacity: "1", scale: "1", translate: "0 0" }, 0);
          this.#finishEntry();
        }
      }),
    );
    this.register(() => this.#pages?.dispose());
    this.register(() => this.#layout.dispose());
    this.#position();
    this.#observeContentSize();
    this.#entryStop = Platform.isPhone
      ? playMenuMotion(
          this.#surface,
          { translate: ["0 100%", "0 0"] },
          this.#entryDuration(),
          () => this.#finishEntry(),
          "ease-out",
        )
      : animateWideMenuEntry(this.#surface, this.#entryDuration(), () => this.#finishEntry());
    this.#openFrame = this.#options.workScheduler.requestFrame(() => {
      this.#openFrame = undefined;
      if (this.#closed) return;
      this.#surface.dataset.state = "open";
      (this.#options.initialFocus ?? this.#focusableElements()[0] ?? this.#surface).focus({
        preventScroll: true,
      });
    });
  }

  #finishEntry(): void {
    if (this.#closed) return;
    delete this.#surface.dataset.presence;
    this.#pages?.finishEntry();
  }

  #refreshFeedback(): void {
    this.#feedbackStop?.();
    this.#feedbackStop = registerMenuFeedback(
      this.#surface,
      this.#motionAnchor,
      this.#options.ownerWindow,
    );
  }

  public mutateLayout(update: () => void): void {
    if (this.#closed || !this.#layer.isConnected || this.#isPhoneDialog()) {
      update();
      return;
    }
    this.#layout.mutate(
      () => {
        update();
        if (!Platform.isPhone) this.#position();
      },
      this.#surface.dataset.presence === "entering" ? 0 : this.#panelDuration(),
    );
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
    this.#layoutFrame = this.#options.workScheduler.requestFrame(() => {
      this.#layoutFrame = undefined;
      if (!Platform.isPhone || this.#positionRequested) this.#position();
      this.#positionRequested = false;
      if (this.#revealEditable && Platform.isPhone && this.#isTopmostLayer()) {
        revealPhoneSheetEditable(this.#scroll, this.#placement.viewport());
      }
      this.#revealEditable = false;
    });
  }

  #cancelScheduledWork(): void {
    if (this.#openFrame !== undefined) {
      this.#options.workScheduler.cancelFrame(this.#openFrame);
      this.#openFrame = undefined;
    }
    if (this.#layoutFrame !== undefined) {
      this.#options.workScheduler.cancelFrame(this.#layoutFrame);
      this.#layoutFrame = undefined;
    }
    this.#entryStop?.();
    this.#entryStop = undefined;
    this.#exitStop?.();
    this.#exitStop = undefined;
  }

  #createGrabber(): HTMLElement {
    const region = this.#surface.createDiv({ cls: "inkbook-adaptive-panel-drag-region" });
    const grabber = region.createDiv({ cls: "inkbook-adaptive-panel-grabber" });
    region.setAttribute("aria-hidden", "true");
    grabber.setAttribute("aria-hidden", "true");
    return region;
  }

  #finishClose(): void {
    if (!this.#layer.isConnected) return;
    this.#cancelScheduledWork();
    this.unload();
    this.#phoneHost?.close();
    this.#layer.remove();
    if (this.#restoreFocus && this.#options.restoreFocus !== false) this.#returnFocus();
    this.#options.onClosed();
  }

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
    const observer = new resizeObserverConstructor(() => this.#requestPosition());
    this.#contentObserver = observer;
    observer.observe(this.#content);
    this.register(() => observer.disconnect());
  }

  #position(): void {
    this.#placement.position();
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
