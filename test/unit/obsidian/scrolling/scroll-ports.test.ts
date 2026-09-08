import { describe, expect, it, vi } from "vitest";

import {
  browserScrollListeners,
  browserScrollMetrics,
  createAnimationFrameScheduler,
  createBrowserScrollDocumentPort,
  type BrowserScrollElement,
} from "../../../../src/obsidian/scrolling";

function asBrowserElement(value: object): BrowserScrollElement {
  return value as BrowserScrollElement;
}

describe("browser scroll ports", () => {
  it("adapts owner-document traversal and computed overflow", () => {
    const parent = asBrowserElement({});
    const child = asBrowserElement({ parentElement: parent });
    const getComputedStyle = vi.fn(() => ({ overflowY: "auto" }));
    const documentScroller = asBrowserElement({});
    const document = {
      defaultView: { getComputedStyle },
      scrollingElement: documentScroller,
    } as unknown as Document;

    const port = createBrowserScrollDocumentPort(document);
    expect(port.getParent(child)).toBe(parent);
    expect(port.getOverflowY(child)).toBe("auto");
    expect(port.scrollingElement).toBe(documentScroller);
    expect(getComputedStyle).toHaveBeenCalledWith(child);
  });

  it("uses visible overflow when the owning document has no view", () => {
    const document = { defaultView: null, scrollingElement: null } as unknown as Document;
    const port = createBrowserScrollDocumentPort(document);

    expect(port.getOverflowY(asBrowserElement({}))).toBe("visible");
  });

  it("adapts scroll metrics", () => {
    const element = asBrowserElement({
      clientHeight: 100,
      scrollHeight: 240,
      scrollTop: 25,
    });

    expect(browserScrollMetrics.getClientHeight(element)).toBe(100);
    expect(browserScrollMetrics.getScrollHeight(element)).toBe(240);
    expect(browserScrollMetrics.getScrollTop(element)).toBe(25);
    browserScrollMetrics.setScrollTop(element, 50);
    expect(element.scrollTop).toBe(50);
  });

  it("owns passive scroll listeners and animation frames through the supplied window", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const element = asBrowserElement({ addEventListener, removeEventListener });
    const listener = vi.fn();
    const cleanup = browserScrollListeners.listen(element, listener);
    expect(addEventListener).toHaveBeenCalledWith("scroll", listener, { passive: true });
    cleanup();
    expect(removeEventListener).toHaveBeenCalledWith("scroll", listener);

    const requestAnimationFrame = vi.fn(() => 17);
    const cancelAnimationFrame = vi.fn();
    const scheduler = createAnimationFrameScheduler({
      cancelAnimationFrame,
      requestAnimationFrame,
    } as unknown as Window);
    const callback = vi.fn();
    expect(scheduler.request(callback)).toBe(17);
    scheduler.cancel(17);
    expect(requestAnimationFrame).toHaveBeenCalledWith(callback);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(17);
  });
});
