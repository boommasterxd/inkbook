import type { FrameScheduler, ScrollListenerPort, ScrollMetricsPort } from "./scroll-ports";

export interface PenScrollGuardOptions<ElementType> {
  readonly listeners: ScrollListenerPort<ElementType>;
  readonly metrics: ScrollMetricsPort<ElementType>;
  readonly scheduler: FrameScheduler;
}

export class PenScrollGuard<ElementType> {
  private cleanupListener: (() => void) | null = null;
  private frame: number | null = null;
  private owner: ElementType | null = null;
  private scrollTop = 0;

  public constructor(private readonly options: PenScrollGuardOptions<ElementType>) {}

  public begin(pointerType: string, owner: ElementType): boolean {
    this.stop();
    if (pointerType !== "pen") return false;

    this.owner = owner;
    this.scrollTop = this.options.metrics.getScrollTop(owner);
    this.cleanupListener = this.options.listeners.listen(owner, () => this.onScroll());
    return true;
  }

  public stop(): void {
    if (this.frame !== null) {
      this.options.scheduler.cancel(this.frame);
      this.frame = null;
    }
    this.cleanupListener?.();
    this.cleanupListener = null;
    this.restorePosition();
    this.owner = null;
  }

  public get active(): boolean {
    return this.owner !== null;
  }

  private onScroll(): void {
    if (this.owner === null || this.frame !== null) return;
    this.frame = this.options.scheduler.request(() => this.restore());
  }

  private restore(): void {
    this.restorePosition();
    this.frame = null;
  }

  private restorePosition(): void {
    const owner = this.owner;
    if (owner !== null && this.options.metrics.getScrollTop(owner) !== this.scrollTop) {
      this.options.metrics.setScrollTop(owner, this.scrollTop);
    }
  }
}
