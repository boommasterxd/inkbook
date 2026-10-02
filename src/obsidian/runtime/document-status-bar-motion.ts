import {
  EASING_TOKENS,
  getTransitionDuration,
  isReducedMotion,
  type MotionPreference,
} from "../../rendering/motion/transitions";

/** Animates only owned content widths supplied by layout, without synchronous measurements. */
export class DocumentStatusBarMotion {
  readonly #root: HTMLElement;
  readonly #readPreference: () => MotionPreference;
  readonly #observer: ResizeObserver | undefined;
  readonly #query: MediaQueryList | undefined;
  readonly #motionChanged = (): void => this.refreshMotion();
  #animation: Animation | undefined;
  #from = 0;
  #target = 0;
  #disposed = false;

  public constructor(
    root: HTMLElement,
    content: HTMLElement,
    readPreference: () => MotionPreference,
  ) {
    this.#root = root;
    this.#readPreference = readPreference;
    const ownerWindow = root.ownerDocument.defaultView;
    this.#query = ownerWindow?.matchMedia?.("(prefers-reduced-motion: reduce)");
    this.#query?.addEventListener("change", this.#motionChanged);
    const observerConstructor = (
      ownerWindow as (Window & { ResizeObserver?: typeof ResizeObserver }) | null
    )?.ResizeObserver;
    this.#observer =
      observerConstructor === undefined
        ? undefined
        : new observerConstructor((entries) => {
            const entry = entries.find((value) => value.target === content);
            if (entry !== undefined) this.#resize(entry.contentRect.width);
          });
    this.#observer?.observe(content);
  }

  public refreshMotion(): void {
    if (!this.#disposed && this.#reduced()) this.#cancel();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#observer?.disconnect();
    this.#query?.removeEventListener("change", this.#motionChanged);
    this.#cancel();
  }

  #resize(target: number): void {
    if (this.#disposed || !Number.isFinite(target) || target < 0 || target === this.#target) return;
    const progress = this.#animation?.effect?.getComputedTiming().progress ?? 1;
    const start =
      this.#animation === undefined
        ? this.#target
        : this.#from + (this.#target - this.#from) * progress;
    this.#cancel();
    this.#target = target;
    if (
      start <= 0 ||
      target <= 0 ||
      !this.#root.isConnected ||
      this.#reduced() ||
      typeof this.#root.animate !== "function"
    )
      return;
    this.#from = start;
    const animation = this.#root.animate([{ width: `${start}px` }, { width: `${target}px` }], {
      duration: getTransitionDuration("styleChange"),
      easing: EASING_TOKENS.standard,
    });
    this.#animation = animation;
    animation.onfinish = () => {
      if (this.#animation === animation) this.#cancel();
    };
  }

  #reduced(): boolean {
    return isReducedMotion(this.#readPreference(), this.#query?.matches ?? false);
  }

  #cancel(): void {
    if (this.#animation === undefined) return;
    this.#animation.onfinish = null;
    this.#animation.cancel();
    this.#animation = undefined;
  }
}
