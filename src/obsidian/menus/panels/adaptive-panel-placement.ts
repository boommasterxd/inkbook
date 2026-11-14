import { Platform } from "obsidian";
import { PhoneSheetHeight, readMenuViewport } from "./menu-viewport";

interface PanelPlacementOptions {
  readonly anchor: HTMLElement;
  readonly layer: HTMLElement;
  readonly surface: HTMLElement;
  readonly ownerWindow: Window;
  readonly onOcclusionChanged?: ((top: number | undefined) => void) | undefined;
  readonly externalFocusTarget?: (() => HTMLElement | undefined) | undefined;
}

/** Measures layout dimensions independently of entry and swipe transforms. */
export class AdaptivePanelPlacement {
  readonly #options: PanelPlacementOptions;
  readonly #phoneHeight = new PhoneSheetHeight();
  #keyboardProbe: HTMLElement | undefined;
  #occlusionTop: number | undefined;

  public constructor(options: PanelPlacementOptions) {
    this.#options = options;
  }

  public get occlusionTop(): number | undefined {
    return this.#occlusionTop;
  }

  public refreshOcclusion(): void {
    const surface = this.#options.surface;
    const measured =
      Platform.isPhone && surface.dataset.kind === "style"
        ? surface.getBoundingClientRect().top
        : undefined;
    this.publishOcclusion(
      measured !== undefined && Number.isFinite(measured) ? measured : undefined,
    );
  }

  public clearOcclusion(): void {
    this.publishOcclusion(undefined);
  }

  private publishOcclusion(top: number | undefined): void {
    if (top === this.#occlusionTop) return;
    this.#occlusionTop = top;
    this.#options.onOcclusionChanged?.(top);
  }

  public observeContent(content: HTMLElement, onResize: () => void): ResizeObserver | undefined {
    const constructor = (
      this.#options.ownerWindow as Window & {
        readonly ResizeObserver?: typeof ResizeObserver;
      }
    ).ResizeObserver;
    if (constructor === undefined) return undefined;
    const observer = new constructor(onResize);
    observer.observe(content);
    return observer;
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
    if (!Platform.isPhone) return Math.max(0, viewport.height - 16);
    let maximum = this.#phoneHeight.maximum(
      viewport,
      ownerWindow.innerHeight,
      surface.dataset.kind === "menu" ? 16 : 0,
    );
    if (surface.dataset.kind === "style" && this.#options.externalFocusTarget?.()?.isConnected)
      maximum = Math.min(maximum, viewport.height * 0.6);
    return Math.max(0, maximum - 16);
  }

  public position(): number | undefined {
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
      this.refreshOcclusion();
      return viewport.height;
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
    return undefined;
  }
}
