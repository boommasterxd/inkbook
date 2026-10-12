import { derivePageExtent } from "../../../domain/geometry/public";
import type { PageV1 } from "../../../domain/schema/public";

export interface PageHeightUpdate {
  readonly animate: boolean;
  readonly height: number;
}

/**
 * Owns page-height hysteresis and the single-target transition lock. DOM
 * animation and scroll compensation remain the responsibility of the layout
 * adapter.
 */
export class ActivePageLayout {
  #height: number | undefined;
  #queuedHeight: number | undefined;
  #selectionOriginalHeight: number | undefined;
  #transitionTarget: number | undefined;

  public get height(): number | undefined {
    return maximumHeight(this.#height, this.#transitionTarget, this.#queuedHeight);
  }

  public get settledHeight(): number | undefined {
    return this.#height;
  }

  public retainMinimumHeight(height: number): void {
    if (!Number.isFinite(height)) return;
    this.#height = retainedHeight(this.#height, height);
    this.#queuedHeight = retainedHeight(this.#queuedHeight, height);
    this.#selectionOriginalHeight = retainedHeight(this.#selectionOriginalHeight, height);
    this.#transitionTarget = retainedHeight(this.#transitionTarget, height);
  }

  public committed(
    page: PageV1,
    maximumBottom: number | undefined,
    force = false,
  ): PageHeightUpdate | undefined {
    if (this.#selectionOriginalHeight !== undefined) return undefined;
    const extent = derivePageExtent(page, maximumBottom ?? null);
    if (this.#height === undefined) return this.#start(extent.activeHeight, false);
    const reference = this.height ?? extent.activeHeight;
    const remainingBuffer = reference - page.margin - extent.occupiedBottom;
    const shouldGrow = extent.activeHeight > reference && remainingBuffer < extent.bufferUnit;
    const shouldShrink = extent.activeHeight <= reference - extent.bufferUnit;
    if (!force && !shouldGrow && !shouldShrink) return undefined;
    return this.#request(extent.activeHeight);
  }

  public beginSelectionMove(): PageHeightUpdate | undefined {
    const height = this.height;
    if (height === undefined) return undefined;
    this.#selectionOriginalHeight = height;
    if (this.#transitionTarget === undefined && this.#queuedHeight === undefined) return undefined;
    this.#height = height;
    this.#transitionTarget = undefined;
    this.#queuedHeight = undefined;
    return { animate: false, height };
  }

  public previewSelectionMove(page: PageV1, maximumBottom: number): PageHeightUpdate | undefined {
    if (this.#selectionOriginalHeight === undefined || !Number.isFinite(maximumBottom)) {
      return undefined;
    }
    const target = derivePageExtent(page, maximumBottom).activeHeight;
    const height = this.height;
    if (height !== undefined && target <= height) return undefined;
    return this.#request(target);
  }

  public finishSelectionMove(
    committed: boolean,
    page: PageV1,
    maximumBottom: number | undefined,
  ): PageHeightUpdate | undefined {
    const originalHeight = this.#selectionOriginalHeight;
    if (originalHeight === undefined) return undefined;
    this.#selectionOriginalHeight = undefined;
    const target = committed
      ? derivePageExtent(page, maximumBottom ?? null).activeHeight
      : originalHeight;
    return this.#request(target);
  }

  public completeTransitions(): PageHeightUpdate | undefined {
    const height = this.height;
    if (
      height === undefined ||
      (this.#transitionTarget === undefined && this.#queuedHeight === undefined)
    ) {
      return undefined;
    }
    this.#height = height;
    this.#transitionTarget = undefined;
    this.#queuedHeight = undefined;
    return { animate: false, height };
  }

  public cancelTransitions(height: number): void {
    this.#height = height;
    this.#queuedHeight = undefined;
    this.#transitionTarget = undefined;
  }

  public transitionCompleted(): PageHeightUpdate | undefined {
    const target = this.#transitionTarget;
    if (target === undefined) return undefined;
    this.#height = target;
    this.#transitionTarget = undefined;
    const queued = this.#queuedHeight;
    this.#queuedHeight = undefined;
    if (queued !== undefined && queued !== target) return this.#start(queued, true);
    return undefined;
  }

  #request(height: number): PageHeightUpdate | undefined {
    if (height === this.height) return undefined;
    if (this.#transitionTarget !== undefined) {
      this.#queuedHeight = height;
      return undefined;
    }
    return this.#start(height, true);
  }

  #start(height: number, animate: boolean): PageHeightUpdate {
    if (animate) this.#transitionTarget = height;
    else this.#height = height;
    return { animate, height };
  }
}

export function maximumHeight(...values: Array<number | undefined>): number | undefined {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  return finite.length === 0 ? undefined : Math.max(...finite);
}

function retainedHeight(current: number | undefined, minimum: number): number | undefined {
  return current === undefined ? undefined : Math.max(current, minimum);
}
