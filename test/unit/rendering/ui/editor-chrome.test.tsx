// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import { registerToolbarResize } from "../../../../src/rendering/ui/editor-chrome";
import { toolbarMainHalfWidth } from "../../../../src/rendering/ui/toolbar-layout";

describe("Inkbook editor chrome layout", () => {
  it("remeasures the primary pill through the owning window resize observer", () => {
    const observer = resizeObserverHarness();
    const onResize = vi.fn();
    const element = {} as Element;
    const dispose = registerToolbarResize(element, observer.ownerDocument, onResize);

    expect(observer.observe).toHaveBeenCalledWith(element);
    observer.notify();
    expect(onResize).toHaveBeenCalledOnce();
    dispose();
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });

  it("anchors context actions to transform-independent primary layout width", () => {
    const transformedVisualBounds = vi.fn(() => ({ width: 120 }));
    const toolbar = {
      getBoundingClientRect: transformedVisualBounds,
      offsetWidth: 556,
      scrollWidth: 556,
    } as unknown as HTMLElement;

    expect(toolbarMainHalfWidth(toolbar)).toBe(278);
    expect(transformedVisualBounds).not.toHaveBeenCalled();
  });
});

function resizeObserverHarness() {
  let notify = (): void => undefined;
  const observe = vi.fn();
  const disconnect = vi.fn();
  class FixtureResizeObserver {
    public constructor(callback: ResizeObserverCallback) {
      notify = () => callback([], this);
    }
    public observe = observe;
    public disconnect = disconnect;
    public unobserve(): void {}
  }
  return {
    disconnect,
    notify: () => notify(),
    observe,
    ownerDocument: {
      defaultView: { ResizeObserver: FixtureResizeObserver },
    } as unknown as Document,
  };
}
