import { menuDomWindow } from "./menu-dom";
import type {
  AdaptivePanelContentLifecycle,
  PhoneSheetNavigation,
  PhoneSheetPage,
} from "./panel-page";

interface PhoneSheetPagesOptions {
  readonly scroll: HTMLElement;
  readonly surface: HTMLElement;
  readonly layer: HTMLElement;
  readonly lifecycle: AdaptivePanelContentLifecycle;
  readonly position: () => void;
  readonly maximumHeight: () => number;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly ownerWindow: Window;
  readonly durationMs: number;
  readonly pageDurationMs: number;
  readonly observeContent: (content: HTMLElement) => void;
  readonly rootContent: HTMLElement;
  readonly close: (mode?: "animated" | "immediate") => void;
}

/** One retained root and at most one disposable subpage share a single sheet host. */
export class PhoneSheetPages implements PhoneSheetNavigation {
  readonly #options: PhoneSheetPagesOptions;
  readonly #root: DocumentFragment;
  readonly #rootKind: string;
  readonly #rootLabel: string;
  #page: PhoneSheetPage | undefined;
  #pending: PhoneSheetPage | undefined;
  #rootFocus: HTMLElement | undefined;
  #rootScroll = 0;
  #timer: number | undefined;
  #closed = false;
  #transitioning = false;
  #paused = false;

  public constructor(options: PhoneSheetPagesOptions) {
    this.#options = options;
    this.#root = menuDomWindow(options.surface.ownerDocument, "phone sheet pages").createFragment();
    this.#rootKind = options.surface.dataset.kind ?? "menu";
    this.#rootLabel = options.surface.getAttribute("aria-label") ?? "";
  }

  public get ownerDocument(): Document {
    return this.#options.surface.ownerDocument;
  }
  public get transitioning(): boolean {
    return this.#transitioning || this.#paused;
  }

  public push(page: PhoneSheetPage): void {
    if (this.#closed) return;
    if (this.#options.surface.dataset.presence === "entering") {
      this.#pending?.dispose?.();
      this.#pending = page;
      return;
    }
    const { scroll } = this.#options;
    const height = scroll.getBoundingClientRect().height;
    const content = page.createContent(this.#options.lifecycle);
    if (this.#page === undefined) {
      const active = this.ownerDocument.activeElement;
      this.#rootFocus =
        active !== null && scroll.contains(active) ? (active as HTMLElement) : undefined;
      this.#rootScroll = scroll.scrollTop;
      this.#root.append(...scroll.childNodes);
    } else this.#page.dispose?.();
    this.#page = page;
    scroll.replaceChildren();
    const body = scroll.createDiv({ cls: "inkbook-phone-sheet-page" });
    this.#createBack(body);
    body.append(content);
    this.#options.observeContent(body);
    this.#show(page.kind, page.label, "forward", height);
    scroll.scrollTop = 0;
    this.#focus(body.querySelector<HTMLElement>("button, input, select, textarea, [tabindex]"));
  }

  public finishEntry(): void {
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending !== undefined) this.push(pending);
  }

  public back(): boolean {
    if (this.#pending !== undefined) {
      this.#pending.dispose?.();
      this.#pending = undefined;
      return true;
    }
    if (this.#closed || this.#page === undefined) return false;
    const { scroll } = this.#options;
    const height = scroll.getBoundingClientRect().height;
    this.#page.dispose?.();
    this.#page = undefined;
    scroll.replaceChildren(this.#root);
    this.#options.observeContent(this.#options.rootContent);
    this.#show(this.#rootKind, this.#rootLabel, "back", height);
    scroll.scrollTop = this.#rootScroll;
    const keyboardNavigation = this.#options.layer.dataset.inkbookKeyboardNavigation === "true";
    this.#focus(keyboardNavigation ? this.#rootFocus : undefined);
    return true;
  }

  public close(mode?: "animated" | "immediate"): void {
    this.#options.close(mode);
  }

  public pauseHeight(): void {
    const { scroll, surface } = this.#options;
    if (this.#closed || !this.#transitioning || !scroll.style.blockSize) return;
    const height = scroll.getBoundingClientRect().height;
    surface.dataset.pageMeasuring = "true";
    this.#stopTransition();
    surface.dataset.pageFrozen = "true";
    scroll.style.setProperty("block-size", `${String(height)}px`);
    scroll.getBoundingClientRect();
    delete surface.dataset.pageMeasuring;
    this.#paused = true;
  }

  public resumeHeight(): void {
    if (this.#closed || !this.#paused) return;
    const { scroll, surface, ownerWindow, durationMs } = this.#options;
    const height = scroll.getBoundingClientRect().height;
    surface.dataset.pageMeasuring = "true";
    this.#stopTransition();
    this.#options.position();
    const target = Math.min(scroll.scrollHeight, this.#options.maximumHeight());
    this.#transitioning = true;
    surface.dataset.pageFrozen = "true";
    this.#animateHeight(height, target);
    this.#timer = ownerWindow.setTimeout(() => this.#stopTransition(), durationMs);
  }

  public dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    const height = this.transitioning ? this.#options.scroll.getBoundingClientRect().height : 0;
    this.#stopTransition();
    if (height > 0) this.#options.surface.dataset.pageFrozen = "true";
    if (height > 0) this.#options.scroll.style.setProperty("block-size", `${String(height)}px`);
    this.#pending?.dispose?.();
    this.#pending = undefined;
    this.#page?.dispose?.();
    this.#page = undefined;
    this.#root.replaceChildren();
  }

  #focus(target: HTMLElement | null | undefined): void {
    (target ?? this.#options.surface).focus({ preventScroll: true });
  }

  #createBack(body: HTMLElement): void {
    const header = body.createDiv({ cls: "inkbook-adaptive-panel-header" });
    const button = header.createEl("button", { cls: "inkbook-adaptive-panel-back" });
    button.type = "button";
    button.setAttribute("aria-label", "Back to more options");
    this.#options.renderIcon(
      button.createSpan({ cls: "inkbook-adaptive-panel-back-icon" }),
      "arrow-left",
    );
    button.createSpan({ text: "Back" });
    button.addEventListener("click", () => this.back());
  }

  #show(kind: string, label: string, direction: string, height: number): void {
    const { scroll, surface, layer, ownerWindow, durationMs } = this.#options;
    surface.dataset.pageMeasuring = "true";
    this.#stopTransition();
    surface.dataset.kind = kind;
    layer.dataset.kind = kind;
    surface.setAttribute("aria-label", label);
    this.#options.position();
    // Measure the new natural height without the previous page's explicit height.
    const target = Math.min(scroll.scrollHeight, this.#options.maximumHeight());
    const pageDuration = this.#options.pageDurationMs;
    if (durationMs === 0 && pageDuration === 0) {
      delete surface.dataset.pageMeasuring;
      return;
    }
    this.#transitioning = true;
    surface.dataset.pageTransition = direction;
    surface.style.setProperty("--inkbook-phone-page-duration", `${String(pageDuration)}ms`);
    this.#animateHeight(height, target);
    this.#timer = ownerWindow.setTimeout(
      () => this.#stopTransition(),
      Math.max(durationMs, pageDuration),
    );
  }

  #animateHeight(height: number, target: number): void {
    const { scroll, surface } = this.#options;
    if (height > 0 && target > 0 && Math.abs(height - target) >= 1) {
      scroll.style.setProperty("block-size", `${String(height)}px`);
      scroll.getBoundingClientRect();
      delete surface.dataset.pageMeasuring;
      scroll.style.setProperty("block-size", `${String(target)}px`);
    }
    delete surface.dataset.pageMeasuring;
  }

  #stopTransition(): void {
    const { scroll, surface, ownerWindow } = this.#options;
    if (this.#timer !== undefined) ownerWindow.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#transitioning = false;
    this.#paused = false;
    delete surface.dataset.pageFrozen;
    delete surface.dataset.pageTransition;
    scroll.style.removeProperty("block-size");
  }
}
