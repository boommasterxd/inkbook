import { Platform } from "obsidian";
import { readMenuViewport } from "../../../menus/panels/menu-viewport";
import type { BrowserScrollElement } from "../../../scrolling/index";
import { readScrollOwnerViewport } from "../../active-scene/active-scene-viewport";

/** Resolves the usable note viewport through host theme insets and the existing scroll owner. */
export class EditorChromeViewport {
  readonly #insets: HTMLElement;

  public constructor(
    root: HTMLElement,
    surface: "onboarding" | "image-crop",
    private readonly scrollOwner?: () => BrowserScrollElement,
  ) {
    this.#insets = root.createDiv({ cls: `inkbook-${surface}-insets` });
    this.#insets.setAttribute("aria-hidden", "true");
    this.#insets.dataset.phone = String(Platform.isPhone);
  }

  public observe(observer: ResizeObserver): void {
    observer.observe(this.#insets, { box: "border-box" });
  }

  public read = (): { bottom: number; left: number; right: number; top: number } => {
    const ownerWindow = this.#insets.ownerDocument.defaultView!;
    const viewport = readMenuViewport(ownerWindow);
    const owner = this.scrollOwner?.();
    const clip = owner === undefined ? undefined : readScrollOwnerViewport(owner);
    const style = ownerWindow.getComputedStyle(this.#insets);
    return {
      bottom: Math.min(
        viewport.top + viewport.height - (Number.parseFloat(style.paddingBottom) || 0),
        clip?.bottom ?? Infinity,
      ),
      left: Math.max(viewport.left, clip?.left ?? 0),
      right: Math.min(viewport.left + viewport.width, clip?.right ?? Infinity),
      top: Math.max(viewport.top + (Number.parseFloat(style.paddingTop) || 0), clip?.top ?? 0),
    };
  };

  public dispose(): void {
    this.#insets.remove();
  }
}
