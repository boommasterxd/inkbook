import { browserScrollMetrics, type BrowserScrollElement } from "../../scrolling/index";

import type { ActiveEditorNavigation } from "./navigation";
import { SelectionEdgeAutoScroller, type SelectionEdgeViewport } from "./selection-edge-scroll";
import type { SelectionEdgeDragPort } from "./selection-preview";

export interface ActiveEditorSelectionEdgeOptions {
  readonly lifecycle: SelectionEdgeDragPort;
  readonly navigation: ActiveEditorNavigation;
  readonly ownerWindow: Window;
  readonly scrollOwner: () => BrowserScrollElement;
}

export class ActiveEditorSelectionEdgeDrag implements SelectionEdgeDragPort {
  readonly #lifecycle: SelectionEdgeDragPort;
  readonly #scroller: SelectionEdgeAutoScroller;

  public constructor(options: ActiveEditorSelectionEdgeOptions) {
    this.#lifecycle = options.lifecycle;
    this.#scroller = new SelectionEdgeAutoScroller({
      cancelFrame: (handle) => options.ownerWindow.cancelAnimationFrame(handle),
      onBottomEdge: (active) => this.#lifecycle.setBottomEdge(active),
      onScroll: ({ x, y }) => {
        if (x !== 0) options.navigation.pan(-x);
        if (y !== 0) options.navigation.scroll(-y);
      },
      readViewport: () => readSelectionViewport(options.scrollOwner(), options.ownerWindow),
      requestFrame: (callback) => options.ownerWindow.requestAnimationFrame(callback),
    });
  }

  public begin(): void {
    this.#lifecycle.begin();
  }

  public finish(outcome: "cancel" | "commit"): void {
    this.#scroller.finish();
    this.#lifecycle.finish(outcome);
  }

  public setBottomEdge(active: boolean): void {
    this.#lifecycle.setBottomEdge(active);
  }

  public update(screenPointer: { readonly x: number; readonly y: number }): void {
    this.#lifecycle.update(screenPointer);
    this.#scroller.update(screenPointer);
  }
}

export function createActiveEditorSelectionEdgeDrag(
  options: Omit<ActiveEditorSelectionEdgeOptions, "lifecycle"> & {
    readonly lifecycle: SelectionEdgeDragPort | undefined;
  },
): ActiveEditorSelectionEdgeDrag | undefined {
  return options.lifecycle === undefined
    ? undefined
    : new ActiveEditorSelectionEdgeDrag({ ...options, lifecycle: options.lifecycle });
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
