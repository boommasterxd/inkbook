export interface FrameScheduler {
  cancel(frame: number): void;
  request(callback: () => void): number;
}

export interface ScrollDocumentPort<ElementType> {
  getOverflowY(element: ElementType): string;
  getParent(element: ElementType): ElementType | null;
  readonly scrollingElement: ElementType | null;
}

export interface ScrollMetricsPort<ElementType> {
  getClientHeight(element: ElementType): number;
  getScrollHeight(element: ElementType): number;
  getScrollTop(element: ElementType): number;
  setScrollTop(element: ElementType, value: number): void;
}

export interface ScrollClassPort<ElementType> {
  add(element: ElementType, className: string): void;
  remove(element: ElementType, className: string): void;
}

export interface ScrollListenerPort<ElementType> {
  listen(element: ElementType, listener: () => void): () => void;
}

export interface BrowserScrollElement extends Element {
  readonly clientHeight: number;
  readonly scrollHeight: number;
  scrollTop: number;
}

export function createBrowserScrollDocumentPort(
  document: Document,
): ScrollDocumentPort<BrowserScrollElement> {
  const view = document.defaultView;
  return {
    getOverflowY: (element) => view?.getComputedStyle(element).overflowY ?? "visible",
    getParent: (element) => element.parentElement,
    scrollingElement: document.scrollingElement,
  };
}

export const browserScrollMetrics: ScrollMetricsPort<BrowserScrollElement> = {
  getClientHeight: (element) => element.clientHeight,
  getScrollHeight: (element) => element.scrollHeight,
  getScrollTop: (element) => element.scrollTop,
  setScrollTop: (element, value) => {
    element.scrollTop = value;
  },
};

export const browserScrollClasses: ScrollClassPort<BrowserScrollElement> = {
  add: (element, className) => element.classList.add(className),
  remove: (element, className) => element.classList.remove(className),
};

export const browserScrollListeners: ScrollListenerPort<BrowserScrollElement> = {
  listen: (element, listener) => {
    element.addEventListener("scroll", listener, { passive: true });
    return () => element.removeEventListener("scroll", listener);
  },
};

export function createAnimationFrameScheduler(view: Window): FrameScheduler {
  return {
    cancel: (frame) => view.cancelAnimationFrame(frame),
    request: (callback) => view.requestAnimationFrame(callback),
  };
}
