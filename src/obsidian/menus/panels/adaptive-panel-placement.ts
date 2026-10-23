import { Platform } from "obsidian";
import { PhoneSheetHeight, readMenuViewport } from "./menu-viewport";

interface PanelPlacementOptions {
  readonly anchor: HTMLElement;
  readonly layer: HTMLElement;
  readonly surface: HTMLElement;
  readonly ownerWindow: Window;
}

/** Measures layout dimensions independently of entry and swipe transforms. */
export class AdaptivePanelPlacement {
  readonly #options: PanelPlacementOptions;
  readonly #phoneHeight = new PhoneSheetHeight();
  #keyboardProbe: HTMLElement | undefined;

  public constructor(options: PanelPlacementOptions) {
    this.#options = options;
  }

  public observeKeyboard(onResize: () => void): () => void {
    if (!Platform.isPhone) return () => undefined;
    const { layer, ownerWindow } = this.#options;
    const probe = layer.createDiv({ cls: "inkbook-phone-keyboard-inset" });
    probe.setAttribute("aria-hidden", "true");
    this.#keyboardProbe = probe;
    const resizeObserverConstructor = (
      ownerWindow as Window & { readonly ResizeObserver?: typeof ResizeObserver }
    ).ResizeObserver;
    const observer =
      resizeObserverConstructor === undefined ? undefined : new resizeObserverConstructor(onResize);
    observer?.observe(probe);
    return () => {
      observer?.disconnect();
      probe.remove();
      this.#keyboardProbe = undefined;
    };
  }

  public viewport(): ReturnType<typeof readMenuViewport> {
    const { ownerWindow } = this.#options;
    const viewport = readMenuViewport(ownerWindow);
    return Platform.isPhone
      ? this.#phoneHeight.viewport(
          viewport,
          ownerWindow.innerHeight,
          this.#keyboardProbe?.offsetHeight ?? 0,
        )
      : viewport;
  }

  #maximumScrollHeight(viewport: ReturnType<typeof readMenuViewport>): number {
    const { ownerWindow, surface } = this.#options;
    return Math.max(
      0,
      Platform.isPhone
        ? this.#phoneHeight.maximum(
            viewport,
            ownerWindow.innerHeight,
            surface.dataset.kind === "menu" ? 16 : 0,
          ) - 16
        : viewport.height - 16,
    );
  }

  public position(): void {
    const { layer, surface, anchor: trigger } = this.#options;
    const viewport = this.viewport();
    const maximumHeight = Platform.isPhone ? this.#maximumScrollHeight(viewport) + 16 : 0;
    for (const property of ["top", "height", "left", "width"] as const) {
      layer.style.setProperty(
        `--inkbook-adaptive-panel-viewport-${property}`,
        `${String(viewport[property])}px`,
      );
    }
    if (Platform.isPhone) {
      layer.style.setProperty(
        "--inkbook-adaptive-panel-maximum-height",
        `${String(maximumHeight)}px`,
      );
      return;
    }
    const anchor = trigger.getBoundingClientRect();
    const panel = { width: surface.offsetWidth, height: surface.offsetHeight };
    const minimum = viewport.left + 8;
    const maximum = Math.max(minimum, viewport.left + viewport.width - panel.width - 8);
    const left = Math.min(
      Math.max(anchor.left + anchor.width / 2 - panel.width / 2, minimum),
      maximum,
    );
    const gap = Platform.isMobile ? 2 : 4;
    const below = anchor.bottom + gap;
    const above = anchor.top - gap - panel.height;
    const top =
      below + panel.height <= viewport.top + viewport.height - 8
        ? below
        : Math.max(viewport.top + 8, above);
    surface.style.setProperty("inset-inline-start", `${String(left)}px`);
    surface.style.setProperty("inset-block-start", `${String(top)}px`);
  }
}
