import type { BrowserScrollElement } from "../scrolling/index";

export const LAYOUT_TRANSITION_CLASS = "inkbook-layout-transitioning";
export const SCROLL_ANCHOR_SUPPRESSED_CLASS = "inkbook-scroll-anchor-suppressed";

const SETTLEMENT_FRAMES = 2;
const SCROLL_KEYS = new Set(["ArrowDown", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "]);

interface TransitionScrollStabilityOptions {
  readonly owner: () => BrowserScrollElement;
  readonly ownerWindow: Window;
  readonly root: HTMLElement;
}

/**
 * Keeps host scroll anchoring and CodeMirror measurement from competing with
 * Inkbook-owned block-height transitions. User scrolling always takes over.
 */
export class TransitionScrollStability {
  readonly #ownerProvider: () => BrowserScrollElement;
  readonly #ownerWindow: Window;
  readonly #root: HTMLElement;
  #activeLeases = 0;
  #anchorViewportY: number | undefined;
  #baseline = 0;
  #correctingScroll = false;
  #disposed = false;
  #frame: number | undefined;
  #owner: BrowserScrollElement | undefined;
  #settlementFrames = 0;
  #userControlled = false;

  public constructor(options: TransitionScrollStabilityOptions) {
    this.#ownerProvider = options.owner;
    this.#ownerWindow = options.ownerWindow;
    this.#root = options.root;
  }

  public begin(): () => void {
    if (this.#disposed) return () => undefined;
    this.#activeLeases += 1;
    if (this.#activeLeases === 1) this.#activate();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#release();
    };
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#activeLeases = 0;
    this.#settlementFrames = 0;
    this.#cancelFrame();
    this.#root.classList.remove(LAYOUT_TRANSITION_CLASS);
    this.#detachOwner();
  }

  #activate(): void {
    this.#settlementFrames = 0;
    this.#userControlled = false;
    this.#root.classList.add(LAYOUT_TRANSITION_CLASS);
    this.#synchronizeOwner();
    this.#scheduleFrame();
  }

  #release(): void {
    if (this.#activeLeases === 0) return;
    this.#activeLeases -= 1;
    if (this.#activeLeases > 0) return;
    this.#root.classList.remove(LAYOUT_TRANSITION_CLASS);
    this.#settlementFrames = SETTLEMENT_FRAMES;
    this.#scheduleFrame();
  }

  #synchronizeOwner(): void {
    const owner = this.#ownerProvider();
    if (owner === this.#owner) return;
    this.#detachOwner();
    this.#owner = owner;
    this.#captureReference(owner);
    owner.classList.add(SCROLL_ANCHOR_SUPPRESSED_CLASS);
    owner.addEventListener("scroll", this.#handleScroll, { passive: true });
    owner.addEventListener("touchmove", this.#handleUserScrollIntent, {
      capture: true,
      passive: true,
    });
    owner.addEventListener("wheel", this.#handleUserScrollIntent, {
      capture: true,
      passive: true,
    });
    owner.ownerDocument.addEventListener("keydown", this.#handleKeyDown, true);
  }

  #detachOwner(): void {
    const owner = this.#owner;
    if (owner === undefined) return;
    owner.classList.remove(SCROLL_ANCHOR_SUPPRESSED_CLASS);
    owner.removeEventListener("scroll", this.#handleScroll);
    owner.removeEventListener("touchmove", this.#handleUserScrollIntent, true);
    owner.removeEventListener("wheel", this.#handleUserScrollIntent, true);
    owner.ownerDocument.removeEventListener("keydown", this.#handleKeyDown, true);
    this.#owner = undefined;
    this.#anchorViewportY = undefined;
  }

  readonly #handleKeyDown = (event: KeyboardEvent): void => {
    if (SCROLL_KEYS.has(event.key)) this.#acceptUserControl();
  };

  readonly #handleUserScrollIntent = (): void => this.#acceptUserControl();

  readonly #handleScroll = (): void => {
    const owner = this.#owner;
    if (owner === undefined || this.#correctingScroll) return;
    if (this.#userControlled) this.#captureReference(owner);
    else this.#stabilize();
  };

  #acceptUserControl(): void {
    this.#userControlled = true;
    if (this.#owner !== undefined) this.#captureReference(this.#owner);
  }

  #scheduleFrame(): void {
    if (this.#frame !== undefined || this.#disposed) return;
    this.#frame = this.#ownerWindow.requestAnimationFrame(this.#tick);
  }

  readonly #tick = (): void => {
    this.#frame = undefined;
    if (this.#disposed) return;
    this.#synchronizeOwner();
    this.#stabilize();
    if (this.#activeLeases > 0) {
      this.#scheduleFrame();
      return;
    }
    if (this.#settlementFrames > 0) {
      this.#settlementFrames -= 1;
      this.#scheduleFrame();
      return;
    }
    this.#detachOwner();
  };

  #stabilize(): void {
    const owner = this.#owner;
    if (owner === undefined) return;
    if (this.#userControlled) {
      this.#captureReference(owner);
      return;
    }
    const currentAnchor = this.#readAnchorViewportY();
    const desired =
      currentAnchor === undefined || this.#anchorViewportY === undefined
        ? this.#baseline
        : owner.scrollTop + currentAnchor - this.#anchorViewportY;
    const reachable = clampScrollTop(owner, desired);
    if (Math.abs(owner.scrollTop - reachable) <= 0.5) return;
    this.#correctingScroll = true;
    owner.scrollTop = reachable;
    this.#correctingScroll = false;
  }

  #captureReference(owner: BrowserScrollElement): void {
    this.#baseline = owner.scrollTop;
    this.#anchorViewportY = this.#readAnchorViewportY();
  }

  #readAnchorViewportY(): number | undefined {
    const anchor = this.#root.getBoundingClientRect().top;
    return Number.isFinite(anchor) ? anchor : undefined;
  }

  #cancelFrame(): void {
    if (this.#frame !== undefined) this.#ownerWindow.cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
  }
}

function clampScrollTop(owner: BrowserScrollElement, value: number): number {
  if (!Number.isFinite(value)) return owner.scrollTop;
  if (owner.scrollHeight === 0 && owner.clientHeight === 0) return Math.max(0, value);
  const maximum = Math.max(0, owner.scrollHeight - owner.clientHeight);
  return Math.min(maximum, Math.max(0, value));
}
