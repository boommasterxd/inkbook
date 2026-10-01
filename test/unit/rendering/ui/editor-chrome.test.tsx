// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { DocumentSaveStatus } from "../../../../src/editor/session/session-port";
import { DocumentSaveStatusIndicator } from "../../../../src/rendering/ui/document-save-status";
import {
  InkbookEditorChrome,
  registerToolbarResize,
} from "../../../../src/rendering/ui/editor-chrome";
import { toolbarMainHalfWidth } from "../../../../src/rendering/ui/toolbar-layout";
import { createEditorChromeProps } from "../../../fixtures/editor-chrome";

describe("Inkbook editor chrome", () => {
  it.each([
    ["saved", "Saved"],
    ["pending", "Unsaved changes"],
    ["saving", "Saving…"],
    ["failed", "Save failed"],
  ] as const)(
    "exposes %s as persistent accessible text outside the scrollable controls",
    (saveStatus, label) => {
      const props = createEditorChromeProps({} as Document);
      const markup = renderToStaticMarkup(
        <InkbookEditorChrome
          {...props}
          layout="scrollable"
          toolbarState={{ ...props.toolbarState, saveStatus }}
        />,
      );
      expect(markup).toContain(`data-save-status="${saveStatus}"`);
      expect(markup).toContain(`${label}</span>`);
      expect(markup).toContain('role="status"');
      expect(markup).toContain('aria-live="polite"');
      expect(markup).toContain('aria-atomic="true"');
      expect(markup).toContain('title="');
      expect(markup).toMatch(/<\/div><\/div><\/div><span[^>]*inkbook-document-save-status/u);
    },
  );
});

describe("document save status icons", () => {
  it("updates decorative save icons only when needed and preserves authoritative status text", () => {
    const reactEnvironment = window as Window & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    const root = createRoot(container);
    const renderIcon = vi.fn((element: HTMLElement, icon: string) => {
      const glyph = document.createElementNS("http://www.w3.org/1999/xhtml", "i");
      glyph.setAttribute("data-icon", icon);
      element.replaceChildren(glyph);
    });
    const render = (status: DocumentSaveStatus): void => {
      act(() =>
        root.render(<DocumentSaveStatusIndicator renderIcon={renderIcon} status={status} />),
      );
    };
    try {
      render("pending");
      const status = container.querySelector("[role='status']") as HTMLElement;
      expect(status.textContent).toBe("Unsaved changes");
      expect(status.querySelector(".inkbook-document-save-status-icon")).toBeNull();
      expect(renderIcon).not.toHaveBeenCalled();

      render("saving");
      const icon = status.querySelector(".inkbook-document-save-status-icon") as HTMLElement;
      expect(icon.getAttribute("aria-hidden")).toBe("true");
      expect(renderIcon).toHaveBeenLastCalledWith(icon, "loader-circle");
      expect(status.textContent).toBe("Saving…");
      render("saving");
      expect(renderIcon).toHaveBeenCalledOnce();

      render("saved");
      expect(renderIcon).toHaveBeenLastCalledWith(icon, "check");
      expect(icon.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe("check");
      expect(status.textContent).toBe("Saved");
      expect(status.getAttribute("title")).toBe("All current changes have been saved.");
      expect(status.getAttribute("aria-live")).toBe("polite");
      expect(status.getAttribute("aria-atomic")).toBe("true");
      render("saved");
      expect(renderIcon).toHaveBeenCalledTimes(2);

      render("pending");
      expect(status.querySelector(".inkbook-document-save-status-icon")).toBeNull();
      render("saving");
      expect(renderIcon).toHaveBeenCalledTimes(3);
      render("failed");
      expect(status.textContent).toBe("Save failed");
      expect(status.querySelector(".inkbook-document-save-status-icon")).toBeNull();
      expect(renderIcon).toHaveBeenCalledTimes(3);
    } finally {
      act(() => root.unmount());
      delete reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
    }
  });
});

describe("Inkbook editor chrome layout", () => {
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
          pasteVisible: false,
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
