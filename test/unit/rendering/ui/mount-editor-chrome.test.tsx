import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { InkbookEditorChromeProps } from "../../../../src/rendering/ui/editor-chrome";
import { mountEditorChrome } from "../../../../src/rendering/ui/mount-editor-chrome";

const reactRoot = vi.hoisted(() => ({ render: vi.fn(), unmount: vi.fn() }));

vi.mock("react-dom/client", () => ({ createRoot: vi.fn(() => reactRoot) }));

function createProps(ownerDocument: Document): InkbookEditorChromeProps {
  return {
    background: { spacing: null, type: "none" },
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
    selectedShape: "line",
    styleControls: [],
    toolbarState: {
      activeTool: "draw",
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

describe("editor chrome mount", () => {
  it("renders, updates, and unmounts one owner-document React root", () => {
    const ownerDocument = {} as Document;
    const mounted = mountEditorChrome({ ownerDocument } as HTMLElement, createProps(ownerDocument));

    expect(createRoot).toHaveBeenCalledOnce();
    expect(mounted.ready).toBeInstanceOf(Promise);
    expect(reactRoot.render).toHaveBeenCalledOnce();
    mounted.update(createProps(ownerDocument));
    expect(reactRoot.render).toHaveBeenCalledTimes(2);
    mounted.unmount();
    mounted.unmount();
    expect(reactRoot.unmount).toHaveBeenCalledOnce();
    expect(() => mounted.update(createProps(ownerDocument))).toThrow(/unmounted/u);
  });

  it("rejects a root or update from another document", () => {
    const ownerDocument = {} as Document;
    const container = { ownerDocument } as HTMLElement;
    expect(() => mountEditorChrome(container, createProps({} as Document))).toThrow(
      /owning document/u,
    );

    const mounted = mountEditorChrome(container, createProps(ownerDocument));
    expect(() => mounted.update(createProps({} as Document))).toThrow(/owning document/u);
  });
});
