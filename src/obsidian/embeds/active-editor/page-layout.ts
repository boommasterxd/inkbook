import { derivePageExtent } from "../../../domain/geometry/public";
import { MAX_DERIVED_HEIGHT, type PageV1 } from "../../../domain/schema/public";

export const AUTOMATIC_PAGE_HEIGHT_TRANSITION_MS = 180;
export const SELECTION_BOTTOM_EDGE_ZONE_PX = 24;

export interface PageHeightUpdate {
  readonly animate: boolean;
  readonly height: number;
}

interface SelectionHeightSession {
  readonly originalHeight: number;
  bottomEdgeActive: boolean;
}

/**
 * Owns page-height hysteresis and the single-target transition lock. DOM
 * animation and scroll compensation remain the responsibility of the layout
 * adapter.
 */
export class ActivePageLayout {
  #height: number | undefined;
  #queuedHeight: number | undefined;
  #selection: SelectionHeightSession | undefined;
  #transitionTarget: number | undefined;

  public get height(): number | undefined {
    return this.#queuedHeight ?? this.#transitionTarget ?? this.#height;
  }

  public committed(
    page: PageV1,
    maximumBottom: number | undefined,
    force = false,
  ): PageHeightUpdate | undefined {
    const extent = derivePageExtent(page, maximumBottom ?? null);
    if (this.#height === undefined) return this.#start(extent.activeHeight, false);
    const reference = this.height ?? extent.activeHeight;
    const remainingBuffer = reference - page.margin - extent.occupiedBottom;
    const shouldGrow = extent.activeHeight > reference && remainingBuffer < extent.bufferUnit;
    const shouldShrink = extent.activeHeight <= reference - extent.bufferUnit;
    if (!force && !shouldGrow && !shouldShrink) return undefined;
    return this.#request(extent.activeHeight);
  }

  public beginSelection(): PageHeightUpdate | undefined {
    const height = this.height;
    if (height === undefined) return undefined;
    this.#selection = { bottomEdgeActive: false, originalHeight: height };
    if (this.#transitionTarget === undefined && this.#queuedHeight === undefined) return undefined;
    this.#height = height;
    this.#transitionTarget = undefined;
    this.#queuedHeight = undefined;
    return { animate: false, height };
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

  public updateSelectionBottomEdge(active: boolean, page: PageV1): PageHeightUpdate | undefined {
    const selection = this.#selection;
    if (selection === undefined) return undefined;
    selection.bottomEdgeActive = active;
    if (!active || this.#transitionTarget !== undefined) return undefined;
    return this.#extendSelection(page);
  }

  public finishSelection(
    outcome: "cancel" | "commit",
    page: PageV1,
    maximumBottom: number | undefined,
  ): PageHeightUpdate | undefined {
    const selection = this.#selection;
    if (selection === undefined) return undefined;
    this.#selection = undefined;
    const height =
      outcome === "cancel"
        ? selection.originalHeight
        : derivePageExtent(page, maximumBottom ?? null).activeHeight;
    return this.#request(height);
  }

  public transitionCompleted(
    page: PageV1,
    continueSelectionExtension = true,
  ): PageHeightUpdate | undefined {
    const target = this.#transitionTarget;
    if (target === undefined) return undefined;
    this.#height = target;
    this.#transitionTarget = undefined;
    const queued = this.#queuedHeight;
    this.#queuedHeight = undefined;
    if (queued !== undefined && queued !== target) return this.#start(queued, true);
    if (continueSelectionExtension && this.#selection?.bottomEdgeActive === true) {
      return this.#extendSelection(page);
    }
    return undefined;
  }

  #extendSelection(page: PageV1): PageHeightUpdate | undefined {
    const height = this.height;
    if (height === undefined || height >= MAX_DERIVED_HEIGHT) return undefined;
    const bufferUnit = derivePageExtent(page, null).bufferUnit;
    return this.#request(Math.min(MAX_DERIVED_HEIGHT, height + bufferUnit));
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
