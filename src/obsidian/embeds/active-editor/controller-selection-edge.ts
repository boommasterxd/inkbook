import { browserScrollMetrics, type BrowserScrollElement } from "../../scrolling/index";

import type { ActiveEditorNavigation } from "./navigation";
import { SelectionEdgeAutoScroller, type SelectionEdgeViewport } from "./selection-edge-scroll";
import type { SelectionEdgeDragPort } from "./selection-preview";

export interface ActiveEditorSelectionEdgeOptions {
  readonly layout: {
    begin(): void;
    finish(committed: boolean, previewMaximumBottom?: number): void;
    updateBottom(maximumBottom: number): void;
  };
  readonly navigation: ActiveEditorNavigation;
  readonly ownerWindow: Window;
  readonly scrollOwner: () => BrowserScrollElement;
}

export class ActiveEditorSelectionEdgeDrag implements SelectionEdgeDragPort {
  readonly #layout: ActiveEditorSelectionEdgeOptions["layout"];
  readonly #scroller: SelectionEdgeAutoScroller;
  #onViewportChanged: (() => void) | undefined;

  public constructor(options: ActiveEditorSelectionEdgeOptions) {
    this.#layout = options.layout;
    this.#scroller = new SelectionEdgeAutoScroller({
      cancelFrame: (handle) => options.ownerWindow.cancelAnimationFrame(handle),
      onFrame: () => this.#onViewportChanged?.(),
      onScroll: ({ x, y }) => {
        if (x !== 0) options.navigation.pan(-x);
        if (y !== 0) options.navigation.scroll(-y);
      },
      readViewport: () => readSelectionViewport(options.scrollOwner(), options.ownerWindow),
      requestFrame: (callback) => options.ownerWindow.requestAnimationFrame(callback),
    });
  }

  public begin(onViewportChanged?: () => void): void {
    this.#layout.begin();
    this.#onViewportChanged = onViewportChanged;
  }

  public finish(committed: boolean, previewMaximumBottom?: number): void {
    this.stop();
    this.#layout.finish(committed, previewMaximumBottom);
  }

  public stop(): void {
    this.#scroller.finish();
    this.#onViewportChanged = undefined;
  }

  public update(screenPointer: { readonly x: number; readonly y: number }): void {
    this.#scroller.update(screenPointer);
  }

  public updatePreviewBottom(maximumBottom: number): void {
    this.#layout.updateBottom(maximumBottom);
  }
}

export function createActiveEditorSelectionEdgeDrag(
  options: ActiveEditorSelectionEdgeOptions,
): ActiveEditorSelectionEdgeDrag {
  return new ActiveEditorSelectionEdgeDrag(options);
}

function readSelectionViewport(
  owner: BrowserScrollElement,
  ownerWindow: Window,
): SelectionEdgeViewport {
  if (owner.ownerDocument.scrollingElement === owner) {
    return { bottom: ownerWindow.innerHeight, left: 0, right: ownerWindow.innerWidth, top: 0 };
  }
  const bounds = owner.getBoundingClientRect();
  const clientWidth = (owner as BrowserScrollElement & { readonly clientWidth?: number })
    .clientWidth;
  return {
    bottom: bounds.top + browserScrollMetrics.getClientHeight(owner),
    left: bounds.left,
    right: bounds.left + (clientWidth ?? bounds.width),
    top: bounds.top,
  };
}
