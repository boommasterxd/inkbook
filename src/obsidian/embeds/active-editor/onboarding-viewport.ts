import { Platform } from "obsidian";
import { browserScrollMetrics, type BrowserScrollElement } from "../../scrolling/index";
import { readScrollOwnerViewport } from "../active-scene/active-scene-viewport";
import { readMenuViewport } from "../../menus/panels/menu-viewport";
import { ONBOARDING_COMPACT_HEIGHT, type OnboardingBounds } from "./onboarding-layout";

/** Uses host theme insets and the existing scroll owner, without host DOM selectors. */
export class OnboardingViewport {
  readonly #root: HTMLElement;
  readonly #insets: HTMLElement;
  readonly #scrollOwner: (() => BrowserScrollElement) | undefined;

  public constructor(root: HTMLElement, scrollOwner?: () => BrowserScrollElement) {
    this.#root = root;
    this.#scrollOwner = scrollOwner;
    this.#insets = root.createDiv({ cls: "inkbook-onboarding-insets" });
    this.#insets.setAttribute("aria-hidden", "true");
    this.#insets.dataset.phone = String(Platform.isPhone);
  }

  public observe(observer: ResizeObserver): void {
    observer.observe(this.#insets);
  }

  public read(): OnboardingBounds {
    const ownerWindow = this.#root.ownerDocument.defaultView!;
    const viewport = readMenuViewport(ownerWindow);
    const owner = this.#scrollOwner?.();
    const clip = owner === undefined ? undefined : readScrollOwnerViewport(owner);
    const style = ownerWindow.getComputedStyle(this.#insets);
    const top = Math.max(viewport.top + (Number.parseFloat(style.paddingTop) || 0), clip?.top ?? 0);
    const bottom = Math.min(
      viewport.top + viewport.height - (Number.parseFloat(style.paddingBottom) || 0),
      clip?.bottom ?? Infinity,
    );
    const left = Math.max(viewport.left, clip?.left ?? 0);
    const right = Math.min(viewport.left + viewport.width, clip?.right ?? Infinity);
    return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  public reveal(paper: HTMLElement, viewport = this.read(), target?: OnboardingBounds): boolean {
    const bounds = paper.getBoundingClientRect();
    const toolbar = this.#root.querySelector<HTMLElement>(".inkbook-toolbar-composition");
    const clearance = Math.max(
      (toolbar?.offsetHeight ?? 50) + (viewport.height < ONBOARDING_COMPACT_HEIGHT ? 8 : 16),
      target === undefined ? 0 : bounds.top - target.top,
    );
    const desiredTop = viewport.top + clearance;
    const required = Math.min(300, Math.max(0, viewport.height - clearance));
    const visible =
      Math.min(bounds.bottom, viewport.top + viewport.height) - Math.max(bounds.top, desiredTop);
    if (visible >= required && bounds.top >= desiredTop) return false;
    const owner = this.#scrollOwner?.();
    if (owner === undefined) {
      paper.scrollIntoView({ block: "start", inline: "nearest" });
      return false;
    }
    const previous = browserScrollMetrics.getScrollTop(owner);
    const next = Math.max(
      0,
      Math.min(
        browserScrollMetrics.getScrollHeight(owner) - browserScrollMetrics.getClientHeight(owner),
        previous + bounds.top - desiredTop,
      ),
    );
    if (Math.abs(previous - next) < 1) return false;
    browserScrollMetrics.setScrollTop(owner, next);
    return Math.abs(browserScrollMetrics.getScrollTop(owner) - previous) >= 1;
  }

  public dispose(): void {
    this.#insets.remove();
  }
}
