import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  InkbookEditorChrome,
  registerToolbarResize,
} from "../../../../src/rendering/ui/editor-chrome";
import { toolbarMainHalfWidth } from "../../../../src/rendering/ui/toolbar-layout";

describe("Inkbook editor chrome", () => {
  it("renders toolbar chrome without scene, canvas, or custom menu content", () => {
    const markup = renderToStaticMarkup(
      <InkbookEditorChrome
        layout="scrollable"
        leftHanded
        onToolbarAction={vi.fn()}
        ownerDocument={{} as Document}
        renderIcon={vi.fn()}
        selectionArea="lasso"
        selectedShape="rectangle"
        shapeIcon={{ arrowEnd: "arrow", arrowStart: "none", coordinateDimension: "2d" }}
        styleIcon={{
          fillColor: null,
          fillOpacity: 0,
          outlineColor: null,
          outlineStyle: "solid",
        }}
        toolbarState={{
          activeTool: "select",
          canPaste: false,
          canRedo: false,
          canUndo: false,
          fingerDrawingAvailable: false,
          fingerDrawingEnabled: false,
          hasSelection: false,
          openFlyout: null,
        }}
      />,
    );

    expect(markup).toContain("inkbook-toolbar-shell");
    expect(markup).toContain("inkbook-toolbar-scrollable");
    expect(markup).toContain("inkbook-toolbar-left-handed");
    expect(markup).toContain('aria-label="Select: Lasso"');
    expect(markup).not.toContain("inkbook-flyout");
    expect(markup).not.toContain("inkbook-scene");
    expect(markup).not.toContain("inkbook-canvas-input");
  });

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
