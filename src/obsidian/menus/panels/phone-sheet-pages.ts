import type { AdaptivePanelLayout } from "./adaptive-panel-layout";
import { menuDomWindow } from "../menu-dom";
import { playMenuMotion } from "../feedback/menu-motion";
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
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly layout: AdaptivePanelLayout;
  readonly durationMs: () => number;
  readonly pageDurationMs: () => number;
  readonly observeContent: (content: HTMLElement) => void;
  readonly refreshFeedback: () => void;
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
  #closed = false;
  #pageStops: (() => void)[] = [];
  #animatedChildren: HTMLElement[] = [];

  public constructor(options: PhoneSheetPagesOptions) {
    this.#options = options;
    this.#root = menuDomWindow(options.surface.ownerDocument, "phone sheet pages").createFragment();
    this.#rootKind = options.surface.dataset.kind ?? "menu";
    this.#rootLabel = options.surface.getAttribute("aria-label") ?? "";
  }

  public get ownerDocument(): Document {
    return this.#options.surface.ownerDocument;
  }
  public push(page: PhoneSheetPage): void {
    if (this.#closed) return;
    if (this.#options.surface.dataset.presence === "entering") {
      this.#pending?.dispose?.();
      this.#pending = page;
      return;
    }
    const { scroll } = this.#options;
    const content = page.createContent(this.#options.lifecycle);
    this.#resetPageMotion();
    this.#options.layout.mutate(() => {
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
      this.#show(page.kind, page.label);
    }, this.#options.durationMs());
    const body = scroll.querySelector<HTMLElement>(".inkbook-phone-sheet-page");
    if (body === null) return;
    this.#options.observeContent(body);
    this.#options.refreshFeedback();
    this.#options.position();
    this.#animatePage("forward");
    scroll.scrollTop = 0;
    this.#focus(body.querySelector<HTMLElement>("button, input, select, textarea, [tabindex]"));
  }

  public finishEntry(): void {
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending !== undefined) this.push(pending);
  }

  public finishMotion(): void {
    this.#resetPageMotion();
  }

  public back(): boolean {
    if (this.#pending !== undefined) {
      this.#pending.dispose?.();
      this.#pending = undefined;
      return true;
    }
    if (this.#closed || this.#page === undefined) return false;
    const { scroll } = this.#options;
    this.#resetPageMotion();
    this.#options.layout.mutate(() => {
      this.#page?.dispose?.();
      this.#page = undefined;
      scroll.replaceChildren(this.#root);
      this.#show(this.#rootKind, this.#rootLabel);
    }, this.#options.durationMs());
    this.#options.observeContent(this.#options.rootContent);
    this.#options.refreshFeedback();
    this.#options.position();
    this.#animatePage("back");
    scroll.scrollTop = this.#rootScroll;
    const keyboardNavigation = this.#options.layer.dataset.inkbookKeyboardNavigation === "true";
    this.#focus(keyboardNavigation ? this.#rootFocus : undefined);
    return true;
  }

  public close(mode?: "animated" | "immediate"): void {
    this.#options.close(mode);
  }

  public dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#resetPageMotion();
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

  #show(kind: string, label: string): void {
    const { surface, layer } = this.#options;
    surface.dataset.kind = kind;
    layer.dataset.kind = kind;
    surface.setAttribute("aria-label", label);
  }

  #animatePage(direction: "forward" | "back"): void {
    const duration = this.#options.pageDurationMs();
    if (duration === 0) return;
    const { scroll, surface } = this.#options;
    const children = [...scroll.children] as HTMLElement[];
    if (children.length === 0) return;
    surface.dataset.pageTransition = direction;
    this.#animatedChildren = children;
    const offset = direction === "back" ? "-12px" : "12px";
    let completed = 0;
    for (const child of children) {
      this.#pageStops.push(
        playMenuMotion(
          child,
          { opacity: ["0", "1"], translate: [`${offset} 0`, "0 0"] },
          duration,
          () => {
            completed += 1;
            if (completed === children.length) this.#resetPageMotion();
          },
          "ease-out",
        ),
      );
    }
  }

  #resetPageMotion(): void {
    this.#pageStops.forEach((stop) => stop());
    this.#pageStops = [];
    for (const child of this.#animatedChildren) {
      child.style.removeProperty("opacity");
      child.style.removeProperty("translate");
    }
    this.#animatedChildren = [];
    delete this.#options.surface.dataset.pageTransition;
  }
}
