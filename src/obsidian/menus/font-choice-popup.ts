import { readMenuViewport } from "./panels/menu-viewport";
import { animateWideMenuEntry } from "./feedback/wide-menu-motion";
import { effectiveTransitionDuration } from "../runtime/effective-motion";
import { observeMenuMotionPreference, playMenuMotion } from "./feedback/menu-motion";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";

/** One floating listbox shares its owning panel's layer without changing panel layout. */
export class FontChoicePopup {
  readonly #anchor: HTMLElement;
  readonly #list: HTMLElement;
  readonly #home: HTMLElement;
  readonly #workScheduler: Pick<WorkScheduler, "requestFrame" | "cancelFrame">;
  #dialog: HTMLElement | null = null;
  #open = false;
  #width = 0;
  #anchorWidth = 0;
  #resizeObserver: ResizeObserver | undefined;
  #stopEntry: (() => void) | undefined;
  #releaseMotion: (() => void) | undefined;
  #positionFrame: number | undefined;

  public constructor(
    anchor: HTMLElement,
    list: HTMLElement,
    workScheduler: Pick<WorkScheduler, "requestFrame" | "cancelFrame">,
  ) {
    this.#anchor = anchor;
    this.#list = list;
    this.#home = list.parentElement!;
    this.#workScheduler = workScheduler;
    anchor.id = `${list.id}-trigger`;
    list.dataset.inkbookMenuAnchor = anchor.id;
  }

  public open(): void {
    if (this.#open) return;
    this.#open = true;
    const { ownerDocument } = this.#anchor;
    const ownerWindow = ownerDocument.defaultView;
    const layer = this.#anchor.closest(".inkbook-adaptive-panel-layer") ?? ownerDocument.body;
    this.#dialog = this.#anchor.closest('[role="dialog"]');
    this.#list.lang =
      this.#anchor.closest<HTMLElement>("[lang]")?.lang ?? ownerDocument.documentElement.lang;
    const owned = this.#dialog?.getAttribute("aria-owns")?.split(/\s+/).filter(Boolean) ?? [];
    this.#dialog?.setAttribute("aria-owns", [...owned, this.#list.id].join(" "));
    layer.append(this.#list);
    this.#list.hidden = false;
    this.#position();
    const resizeObserverConstructor = (
      ownerWindow as (Window & { ResizeObserver?: typeof ResizeObserver }) | null
    )?.ResizeObserver;
    if (resizeObserverConstructor !== undefined) {
      this.#resizeObserver = new resizeObserverConstructor(this.#requestPosition);
      this.#resizeObserver.observe(this.#list);
      this.#resizeObserver.observe(this.#anchor);
    }
    ownerWindow?.addEventListener("resize", this.#position);
    ownerWindow?.visualViewport?.addEventListener("resize", this.#position);
    ownerWindow?.visualViewport?.addEventListener("scroll", this.#position);
    ownerDocument.addEventListener("scroll", this.#onScroll, true);
    if (ownerWindow !== null) {
      this.#stopEntry = animateWideMenuEntry(
        this.#list,
        effectiveTransitionDuration(this.#anchor, ownerWindow, "nativeModalEnterExit"),
        this.#position,
      );
      this.#releaseMotion = observeMenuMotionPreference(this.#anchor, ownerWindow, () => {
        this.#stopEntry?.();
        this.#stopEntry = undefined;
        playMenuMotion(this.#list, { opacity: "1", scale: "1" }, 0);
      });
    }
  }

  public close(): void {
    if (!this.#open) return;
    this.#open = false;
    if (this.#positionFrame !== undefined) {
      this.#workScheduler.cancelFrame(this.#positionFrame);
      this.#positionFrame = undefined;
    }
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    this.#stopEntry?.();
    this.#stopEntry = undefined;
    this.#releaseMotion?.();
    this.#releaseMotion = undefined;
    const { ownerDocument } = this.#anchor;
    const ownerWindow = ownerDocument.defaultView;
    ownerWindow?.removeEventListener("resize", this.#position);
    ownerWindow?.visualViewport?.removeEventListener("resize", this.#position);
    ownerWindow?.visualViewport?.removeEventListener("scroll", this.#position);
    ownerDocument.removeEventListener("scroll", this.#onScroll, true);
    const owned =
      this.#dialog
        ?.getAttribute("aria-owns")
        ?.split(/\s+/)
        .filter((id) => id !== this.#list.id) ?? [];
    if (owned.length === 0) this.#dialog?.removeAttribute("aria-owns");
    else this.#dialog?.setAttribute("aria-owns", owned.join(" "));
    this.#dialog = null;
    this.#list.hidden = true;
    this.#home.append(this.#list);
  }

  readonly #onScroll = (event: Event): void => {
    if (
      event.target instanceof this.#anchor.ownerDocument.defaultView!.Node &&
      this.#list.contains(event.target)
    )
      return;
    this.#position();
  };

  readonly #requestPosition = (): void => {
    if (!this.#open || this.#positionFrame !== undefined) return;
    this.#positionFrame = this.#workScheduler.requestFrame(() => {
      this.#positionFrame = undefined;
      if (
        this.#open &&
        (this.#anchor.getBoundingClientRect().width !== this.#anchorWidth ||
          this.#list.offsetWidth !== this.#width)
      )
        this.#position();
    });
  };

  readonly #position = (): void => {
    const ownerWindow = this.#anchor.ownerDocument.defaultView;
    if (!this.#open || ownerWindow === null) return;
    const viewport = readMenuViewport(ownerWindow);
    const anchor = this.#anchor.getBoundingClientRect();
    const availableWidth = Math.max(0, viewport.width - 16);
    this.#list.style.setProperty("max-inline-size", `${String(availableWidth)}px`);
    this.#list.style.setProperty(
      "inline-size",
      `${String(Math.min(anchor.width, availableWidth))}px`,
    );
    this.#anchorWidth = anchor.width;
    const width = this.#list.offsetWidth;
    this.#width = width;
    const left = Math.max(
      viewport.left + 8,
      Math.min(anchor.left, viewport.left + viewport.width - width - 8),
    );
    const below = Math.max(0, viewport.top + viewport.height - anchor.bottom - 12);
    const above = Math.max(0, anchor.top - viewport.top - 12);
    const naturalHeight = this.#list.scrollHeight;
    const upward = below < Math.min(264, naturalHeight) && above > below;
    const height = Math.min(264, Math.max(0, viewport.height - 16), upward ? above : below);
    this.#list.style.setProperty("max-block-size", `${String(height)}px`);
    const renderedHeight = Math.min(naturalHeight, height);
    const top = Math.max(
      viewport.top + 8,
      Math.min(
        upward ? anchor.top - renderedHeight - 4 : anchor.bottom + 4,
        viewport.top + viewport.height - renderedHeight - 8,
      ),
    );
    this.#list.style.setProperty("inset-inline-start", `${String(left)}px`);
    this.#list.style.setProperty("inset-block-start", `${String(top)}px`);
    this.#list.style.setProperty("transform-origin", upward ? "bottom left" : "top left");
  };
}
