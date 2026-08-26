import type { BrowserScrollElement } from "../scrolling/index";

export const LAYOUT_TRANSITION_CLASS = "inkbook-layout-transitioning";
export const SCROLL_ANCHOR_SUPPRESSED_CLASS = "inkbook-scroll-anchor-suppressed";
export const SCROLL_RANGE_RESERVE_CLASS = "inkbook-scroll-range-reserve";

const SETTLEMENT_FRAMES = 2;
const MAX_SETTLEMENT_FRAMES = 12;
const SCROLL_KEYS = new Set(["ArrowDown", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "]);

interface TransitionScrollStabilityOptions {
  readonly owner: () => BrowserScrollElement;
  readonly ownerWindow: Window;
  readonly rangeReserve?: PresentationScrollRangeReserve;
  readonly root: HTMLElement;
}

/** Retains an otherwise unreachable bottom position across editor disposal. */
export class PresentationScrollRangeReserve {
  readonly #ownerProvider: () => BrowserScrollElement | null;
  #owner: BrowserScrollElement | undefined;
  #reserve: HTMLElement | undefined;
  #trailingContent = 0;

  public constructor(owner: () => BrowserScrollElement | null) {
    this.#ownerProvider = owner;
  }

  public retain(reserve: HTMLElement, trailingContent: number): void {
    this.dispose();
    this.#reserve = reserve;
    this.#trailingContent = trailingContent;
    const owner = this.#ownerProvider();
    if (owner === null) return;
    this.#owner = owner;
    owner.addEventListener("touchmove", this.#release, { capture: true, passive: true });
    owner.addEventListener("wheel", this.#release, { capture: true, passive: true });
    owner.ownerDocument.addEventListener("keydown", this.#handleKeyDown, true);
  }

  public take(): { readonly element: HTMLElement; readonly trailingContent: number } | undefined {
    const reserve = this.#reserve;
    const trailingContent = this.#trailingContent;
    this.#reserve = undefined;
    this.#trailingContent = 0;
    this.#detachOwner();
    return reserve === undefined ? undefined : { element: reserve, trailingContent };
  }

  public dispose(): void {
    this.take()?.element.remove();
  }

  readonly #handleKeyDown = (event: KeyboardEvent): void => {
    if (SCROLL_KEYS.has(event.key)) this.dispose();
  };

  readonly #release = (): void => this.dispose();

  #detachOwner(): void {
    const owner = this.#owner;
    if (owner === undefined) return;
    owner.removeEventListener("touchmove", this.#release, true);
    owner.removeEventListener("wheel", this.#release, true);
    owner.ownerDocument.removeEventListener("keydown", this.#handleKeyDown, true);
    this.#owner = undefined;
  }
}

/**
 * Keeps host scroll anchoring and CodeMirror measurement from competing with
 * Inkbook-owned block-height transitions. User scrolling always takes over.
 */
export class TransitionScrollStability {
  readonly #ownerProvider: () => BrowserScrollElement;
  readonly #ownerWindow: Window;
  readonly #persistentRangeReserve: PresentationScrollRangeReserve | undefined;
  readonly #root: HTMLElement;
  #activeLeases = 0;
  #anchorViewportY: number | undefined;
  #baseline = 0;
  #correctingScroll = false;
  #disposed = false;
  #frame: number | undefined;
  #owner: BrowserScrollElement | undefined;
  #rangeReserve: HTMLElement | undefined;
  #rangeReserveTrailingContent = 0;
  #settlementAttempts = 0;
  #settlementFrames = 0;
  readonly #settlementWaiters = new Set<() => void>();
  #userControlled = false;

  public constructor(options: TransitionScrollStabilityOptions) {
    this.#ownerProvider = options.owner;
    this.#ownerWindow = options.ownerWindow;
    this.#persistentRangeReserve = options.rangeReserve;
    this.#root = options.root;
  }

  public begin(minimumRangeReserve = 0): () => void {
    if (this.#disposed) return () => undefined;
    this.#activeLeases += 1;
    if (this.#activeLeases === 1) this.#activate(minimumRangeReserve);
    else this.#ensureRangeReserve(minimumRangeReserve);
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
    this.#resolveSettlementWaiters();
  }

  public waitForSettlement(): Promise<void> {
    if (this.#isSettled()) return Promise.resolve();
    return new Promise((resolve) => this.#settlementWaiters.add(resolve));
  }

  #activate(minimumRangeReserve: number): void {
    this.#settlementFrames = 0;
    this.#settlementAttempts = 0;
    this.#userControlled = false;
    this.#cancelFrame();
    this.#root.classList.add(LAYOUT_TRANSITION_CLASS);
    const previousOwner = this.#owner;
    this.#synchronizeOwner();
    if (this.#owner !== undefined && this.#owner === previousOwner) {
      this.#captureReference(this.#owner);
    }
    const retainedReserve = this.#persistentRangeReserve?.take();
    if (this.#rangeReserve === undefined && retainedReserve !== undefined) {
      this.#rangeReserve = retainedReserve.element;
      this.#rangeReserveTrailingContent = retainedReserve.trailingContent;
    }
    this.#ensureRangeReserve(minimumRangeReserve);
    this.#scheduleFrame();
  }

  #release(): void {
    if (this.#activeLeases === 0) return;
    this.#activeLeases -= 1;
    if (this.#activeLeases > 0) return;
    this.#root.classList.remove(LAYOUT_TRANSITION_CLASS);
    this.#settlementFrames = SETTLEMENT_FRAMES;
    this.#settlementAttempts = 0;
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
    this.#removeRangeReserve();
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
    this.#removeRangeReserve();
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
    if (this.#activeLeases === 0) this.#releaseRangeReserveIfReachable();
    this.#stabilize();
    if (this.#activeLeases > 0) {
      this.#scheduleFrame();
      return;
    }
    this.#settlementAttempts += 1;
    if (this.#rangeReserve !== undefined && this.#settlementAttempts < MAX_SETTLEMENT_FRAMES) {
      this.#settlementFrames = SETTLEMENT_FRAMES;
      this.#scheduleFrame();
      return;
    }
    if (this.#settlementFrames > 0) {
      this.#settlementFrames -= 1;
      this.#scheduleFrame();
      return;
    }
    const reserve = this.#rangeReserve;
    this.#rangeReserve = undefined;
    if (reserve !== undefined) {
      if (this.#persistentRangeReserve === undefined) reserve.remove();
      else this.#persistentRangeReserve.retain(reserve, this.#rangeReserveTrailingContent);
    }
    this.#detachOwner();
    this.#resolveSettlementWaiters();
  };

  #stabilize(): void {
    const owner = this.#owner;
    if (owner === undefined) return;
    if (this.#userControlled) {
      this.#captureReference(owner);
      return;
    }
    const desired = this.#desiredScrollTop(owner);
    let reachable = clampScrollTop(owner, desired);
    const rangeDeficit = desired - reachable;
    if (rangeDeficit > 0.5) {
      this.#reserveScrollRange(rangeDeficit);
      reachable = clampScrollTop(owner, desired);
    }
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

  #reserveScrollRange(deficit: number): void {
    const current = this.#rangeReserve;
    const parsedSize = current === undefined ? 0 : Number.parseFloat(current.style.blockSize);
    const currentSize = Number.isFinite(parsedSize) ? parsedSize : 0;
    const reserve = current ?? this.#createRangeReserve();
    const baseSize = current === undefined ? this.#rangeReserveTrailingContent : currentSize;
    reserve.style.blockSize = `${String(baseSize + deficit)}px`;
  }

  #ensureRangeReserve(minimumAdditionalRange: number): void {
    if (!Number.isFinite(minimumAdditionalRange) || minimumAdditionalRange <= 0.5) return;
    const current = this.#rangeReserve;
    const parsedSize = current === undefined ? 0 : Number.parseFloat(current.style.blockSize);
    const currentSize = Number.isFinite(parsedSize) ? parsedSize : 0;
    const reserve = current ?? this.#createRangeReserve();
    const minimumSize = this.#rangeReserveTrailingContent + minimumAdditionalRange;
    if (currentSize < minimumSize) reserve.style.blockSize = `${String(minimumSize)}px`;
  }

  #createRangeReserve(): HTMLElement {
    const reserve = this.#root.createSpan();
    reserve.className = SCROLL_RANGE_RESERVE_CLASS;
    reserve.setAttribute("aria-hidden", "true");
    this.#rangeReserveTrailingContent = this.#measureTrailingContent();
    this.#rangeReserve = reserve;
    return reserve;
  }

  #removeRangeReserve(): void {
    this.#rangeReserve?.remove();
    this.#rangeReserve = undefined;
    this.#rangeReserveTrailingContent = 0;
  }

  #releaseRangeReserveIfReachable(): void {
    const owner = this.#owner;
    const reserve = this.#rangeReserve;
    if (owner === undefined || reserve === undefined) return;
    const desired = this.#desiredScrollTop(owner);
    const naturalMaximum = Math.max(
      0,
      this.#rootBottomInScrollContent(owner) +
        this.#rangeReserveTrailingContent -
        owner.clientHeight,
    );
    if (desired > naturalMaximum + 0.5) return;
    this.#removeRangeReserve();
  }

  #measureTrailingContent(): number {
    const owner = this.#owner;
    return owner === undefined
      ? 0
      : Math.max(0, owner.scrollHeight - this.#rootBottomInScrollContent(owner));
  }

  #rootBottomInScrollContent(owner: BrowserScrollElement): number {
    return (
      owner.scrollTop +
      this.#root.getBoundingClientRect().bottom -
      owner.getBoundingClientRect().top
    );
  }

  #desiredScrollTop(owner: BrowserScrollElement): number {
    const currentAnchor = this.#readAnchorViewportY();
    return currentAnchor === undefined || this.#anchorViewportY === undefined
      ? this.#baseline
      : owner.scrollTop + currentAnchor - this.#anchorViewportY;
  }

  #isSettled(): boolean {
    return (
      this.#disposed ||
      (this.#activeLeases === 0 && this.#frame === undefined && this.#owner === undefined)
    );
  }

  #resolveSettlementWaiters(): void {
    for (const resolve of this.#settlementWaiters) resolve();
    this.#settlementWaiters.clear();
  }
}

function clampScrollTop(owner: BrowserScrollElement, value: number): number {
  if (!Number.isFinite(value)) return owner.scrollTop;
  if (owner.scrollHeight === 0 && owner.clientHeight === 0) return Math.max(0, value);
  const maximum = Math.max(0, owner.scrollHeight - owner.clientHeight);
  return Math.min(maximum, Math.max(0, value));
}
