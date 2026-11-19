import { browserScrollMetrics, type BrowserScrollElement } from "../../scrolling/index";
import { EditorChromeViewport } from "./layout/editor-chrome-viewport";
import { ONBOARDING_COMPACT_HEIGHT, type OnboardingBounds } from "./onboarding-layout";

export class OnboardingViewport {
  readonly #root: HTMLElement;
  readonly #viewport: EditorChromeViewport;
  readonly #scrollOwner: (() => BrowserScrollElement) | undefined;

  public constructor(root: HTMLElement, scrollOwner?: () => BrowserScrollElement) {
    this.#root = root;
    this.#scrollOwner = scrollOwner;
    this.#viewport = new EditorChromeViewport(root, "onboarding", scrollOwner);
  }

  public observe(observer: ResizeObserver): void {
    this.#viewport.observe(observer);
  }

  public read(): OnboardingBounds {
    const { bottom, left, right, top } = this.#viewport.read();
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
    this.#viewport.dispose();
  }
}
