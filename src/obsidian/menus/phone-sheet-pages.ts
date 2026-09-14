import type { AdaptivePanelHeight } from "./adaptive-panel-height";
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
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly height: AdaptivePanelHeight;
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
  #closed = false;

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

  public dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
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

  #show(kind: string, label: string, direction: "forward" | "back", height: number): void {
    const { surface, layer } = this.#options;
    surface.dataset.kind = kind;
    layer.dataset.kind = kind;
    surface.setAttribute("aria-label", label);
    this.#options.position();
    this.#options.height.animate(height, direction);
  }
}
