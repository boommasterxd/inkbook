import { keyframes } from "motion";
import { STANDARD_EASING } from "../../../../rendering/motion/transitions";
import { effectiveTransitionDuration } from "../../../runtime/effective-motion";
import type { Bounds } from "../../../../domain/geometry/public";
import type { BrowserScrollElement } from "../../../scrolling/index";
import { planBoundsReveal, readNavigationLayout } from "./navigation-layout";

interface RevealOptions {
  readonly bounds: Bounds;
  readonly container: HTMLElement;
  readonly scrollOwner: BrowserScrollElement;
  readonly ownerWindow: Window;
  readonly camera: { readonly x: number; readonly zoom: number };
  readonly pageHeight: () => number;
  readonly viewportBottom: number | undefined;
  readonly reserveBottom: ((minimumBottom: number) => void) | undefined;
  readonly animate: boolean;
}

/** Samples full Motion values on the existing navigation frame, without owning a clock. */
export class NavigationBoundsReveal {
  #target: { cameraX: number; scrollTop: number } | undefined;
  #tween: ReturnType<typeof keyframes<number>> | undefined;
  #started: number | undefined;
  #progress = 0;

  public get active(): boolean {
    return this.#target !== undefined;
  }

  public request(options: RevealOptions): { panX: number; panY: number } | undefined {
    let layout = readNavigationLayout(options.container, options.scrollOwner);
    if (!layout) return undefined;
    let plan = planBoundsReveal(layout, options.bounds, options.camera, options.viewportBottom);
    if (plan.deficit > 0 && options.reserveBottom) {
      options.reserveBottom(options.pageHeight() + plan.deficit / options.camera.zoom);
      layout = readNavigationLayout(options.container, options.scrollOwner) ?? layout;
      plan = planBoundsReveal(layout, options.bounds, options.camera, options.viewportBottom);
    }
    const duration = options.animate
      ? effectiveTransitionDuration(options.container, options.ownerWindow, "automaticPageGrowth")
      : 0;
    if (duration === 0) {
      this.cancel();
      return plan;
    }
    if (plan.panX === 0 && plan.panY === 0) {
      this.cancel();
      return undefined;
    }
    this.#target = {
      cameraX: options.camera.x + plan.panX / options.camera.zoom,
      scrollTop: layout.scrollTop - plan.panY,
    };
    this.#tween ??= keyframes({ keyframes: [0, 1], duration, ease: STANDARD_EASING });
    return undefined;
  }

  public advance(timestamp: number, scrollTop: number, cameraX: number, zoom: number) {
    const target = this.#target;
    if (!target || !this.#tween) return { panX: 0, panY: 0 };
    this.#started ??= timestamp;
    const sample = this.#tween.next(timestamp - this.#started);
    // Retarget from the actual position using only the remaining eased fraction.
    // The original settle deadline survives repeated input and host-height corrections.
    const ratio = sample.done ? 1 : (sample.value - this.#progress) / (1 - this.#progress);
    this.#progress = sample.value;
    const delta = {
      panX: (target.cameraX - cameraX) * zoom * ratio,
      panY: (scrollTop - target.scrollTop) * ratio,
    };
    if (sample.done) this.cancel();
    return delta;
  }

  public cancel(): void {
    this.#target = undefined;
    this.#tween = undefined;
    this.#started = undefined;
    this.#progress = 0;
  }
}
