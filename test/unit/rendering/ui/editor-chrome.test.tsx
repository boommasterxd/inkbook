import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  InkbookEditorChrome,
  renderEditorFlyoutContent,
  resolveToolbarOverflow,
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
          onShapeChange: vi.fn(),
          onStyleChange: vi.fn(),
        }}
        canvasInput={null}
        layout="scrollable"
        leftHanded
        onToolbarAction={vi.fn()}
        ownerDocument={{} as Document}
        renderIcon={vi.fn()}
        selectedShape="rectangle"
        styleControls={[]}
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
    expect(markup).not.toContain("inkbook-scene");
    expect(markup).not.toContain("inkbook-canvas-input");
  });

  it("resolves scroll gradients only where toolbar content remains", () => {
    expect(resolveToolbarOverflow("wide", 100, 20, 300)).toEqual({ start: false, end: false });
    expect(resolveToolbarOverflow("scrollable", 100, 0, 300)).toEqual({
      start: false,
      end: true,
    });
    expect(resolveToolbarOverflow("scrollable", 100, 100, 300)).toEqual({
      start: true,
      end: true,
    });
    expect(resolveToolbarOverflow("scrollable", 100, 200, 300)).toEqual({
      start: true,
      end: false,
    });
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
      onShapeChange: vi.fn(),
      onStyleChange: vi.fn(),
    },
    canvasInput: null,
    layout: "wide",
    onToolbarAction: vi.fn(),
    ownerDocument,
    renderIcon: vi.fn(),
    selectedShape: "rectangle",
    styleControls: [],
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
