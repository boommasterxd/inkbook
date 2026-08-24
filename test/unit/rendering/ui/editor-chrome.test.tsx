import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  InkbookEditorChrome,
  registerToolbarResize,
  renderEditorFlyoutContent,
} from "../../../../src/rendering/ui/editor-chrome";
import type { InkbookEditorChromeProps } from "../../../../src/rendering/ui/editor-chrome";

describe("Inkbook editor chrome", () => {
  it("renders callback-driven chrome without scene or canvas content", () => {
    const markup = renderToStaticMarkup(
      <InkbookEditorChrome
        background={{ spacing: "m", type: "lines" }}
        callbacks={{
          onBackgroundSpacingChange: vi.fn(),
          onBackgroundTypeChange: vi.fn(),
          onFlyoutClose: vi.fn(),
          onOverflowAction: vi.fn(),
          onShapeChange: vi.fn(),
          onStyleChange: vi.fn(),
        }}
        canvasInput={null}
        layout="scrollable"
        leftHanded
        onToolbarAction={vi.fn()}
        ownerDocument={{} as Document}
        overflowMenu={{
          arrange: {
            "bring-forward": false,
            "bring-to-front": false,
            "send-backward": false,
            "send-to-back": false,
          },
          canEraseAll: false,
          hasSelection: false,
        }}
        renderIcon={vi.fn()}
        selectedShape="rectangle"
        styleControls={[]}
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
    expect(markup).not.toContain("inkbook-toolbar-edge");
    expect(markup).not.toContain("inkbook-scene");
    expect(markup).not.toContain("inkbook-canvas-input");
  });

  it("selects the content for each controlled flyout", () => {
    const ownerDocument = {} as Document;
    const props = createProps(ownerDocument);
    expect(renderNode(renderEditorFlyoutContent("background", props))).toContain("Background type");
    expect(renderNode(renderEditorFlyoutContent("shape", props))).toContain("Rectangle");
    expect(renderNode(renderEditorFlyoutContent("style", props))).toContain(
      "No shared style options",
    );
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
});

function renderNode(node: ReactNode): string {
  if (!isValidElement(node)) throw new Error("Expected flyout content to be a React element.");
  return renderToStaticMarkup(node);
}

function createProps(ownerDocument: Document): InkbookEditorChromeProps {
  return {
    background: { spacing: "m", type: "lines" },
    callbacks: {
      onBackgroundSpacingChange: vi.fn(),
      onBackgroundTypeChange: vi.fn(),
      onFlyoutClose: vi.fn(),
      onOverflowAction: vi.fn(),
      onShapeChange: vi.fn(),
      onStyleChange: vi.fn(),
    },
    canvasInput: null,
    layout: "wide",
    onToolbarAction: vi.fn(),
    ownerDocument,
    overflowMenu: {
      arrange: {
        "bring-forward": false,
        "bring-to-front": false,
        "send-backward": false,
        "send-to-back": false,
      },
      canEraseAll: false,
      hasSelection: false,
    },
    renderIcon: vi.fn(),
    selectedShape: "rectangle",
    styleControls: [],
    styleIcon: { fillColor: null, fillOpacity: 0, outlineColor: null, outlineStyle: "solid" },
    toolbarState: {
      activeTool: "select",
      canPaste: false,
      canRedo: false,
      canUndo: false,
      fingerDrawingAvailable: false,
      fingerDrawingEnabled: false,
      hasSelection: false,
      openFlyout: null,
    },
  };
}

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
