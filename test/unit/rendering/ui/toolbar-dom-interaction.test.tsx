// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  InkbookEditorChrome,
  type InkbookEditorChromeProps,
} from "../../../../src/rendering/ui/editor-chrome";
import { InkbookToolbar } from "../../../../src/rendering/ui/toolbar";
import type { ToolbarAction, ToolbarState } from "../../../../src/rendering/ui/toolbar-types";

const completeState: ToolbarState = {
  activeTool: "draw",
  canPaste: true,
  canRedo: true,
  canUndo: true,
  fingerDrawingAvailable: true,
  fingerDrawingEnabled: false,
  hasSelection: true,
  openFlyout: null,
};

const reactEnvironment = window as Window & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

beforeAll(() => {
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
});

beforeEach(installCreateDiv);

afterEach(() => {
  document.body.replaceChildren();
});

describe("mounted Inkbook toolbar accessibility", () => {
  it("moves a single roving focus stop within each group and leaves Tab unhandled", () => {
    const mounted = mountToolbar(completeState);
    const select = mounted.button("select");
    focus(select);

    expect(key(select, "ArrowRight").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(mounted.button("eraser"));
    expect(key(document.activeElement as HTMLElement, "End").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(mounted.button("style"));
    expect(key(document.activeElement as HTMLElement, "Home").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(select);
    expect(key(select, "ArrowLeft").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(mounted.button("style"));

    const tab = key(document.activeElement as HTMLElement, "Tab");
    expect(tab.defaultPrevented).toBe(false);
    expect(groupTabStops(mounted.container)).toEqual([1, 1, 1]);
    mounted.unmount();
  });

  it("gives every icon-only control a matching accessible name and tooltip", () => {
    const mounted = mountToolbar(completeState);
    const toolbar = mounted.container.querySelector<HTMLElement>("[role='toolbar']");
    const groups = mounted.container.querySelectorAll<HTMLElement>("[role='group']");
    const buttons =
      mounted.container.querySelectorAll<HTMLButtonElement>(".inkbook-toolbar-button");

    expect(toolbar?.getAttribute("aria-label")).toBe("Inkbook tools");
    expect([...groups].map((group) => group.getAttribute("aria-label"))).toEqual([
      "General actions",
      "Drawing tools",
      "Selection and document actions",
    ]);
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      const name = button.getAttribute("aria-label");
      expect(name).toBeTruthy();
      expect(button.title).toBe(name);
      expect(button.querySelector(".inkbook-toolbar-icon")?.getAttribute("aria-hidden")).toBe(
        "true",
      );
    }
    expect(mounted.button("draw").getAttribute("aria-pressed")).toBe("true");
    mounted.unmount();
  });

  it("updates the active tool on stable 44-pixel controls without replacing their icons", () => {
    const mounted = mountToolbar(completeState);
    const draw = mounted.button("draw");
    const select = mounted.button("select");
    const drawIcon = requiredElement<HTMLElement>(draw, ".inkbook-toolbar-icon");
    const selectIcon = requiredElement<HTMLElement>(select, ".inkbook-toolbar-icon");

    mounted.update({ ...completeState, activeTool: "select" });

    expect(mounted.button("draw")).toBe(draw);
    expect(mounted.button("select")).toBe(select);
    expect(draw.getAttribute("aria-pressed")).toBe("false");
    expect(select.getAttribute("aria-pressed")).toBe("true");
    expect(requiredElement(draw, ".inkbook-toolbar-icon")).toBe(drawIcon);
    expect(requiredElement(select, ".inkbook-toolbar-icon")).toBe(selectIcon);
    mounted.unmount();
  });

  it("moves focus to the nearest surviving control before an exit animation completes", () => {
    const mounted = mountToolbar({ ...completeState, canPaste: false });
    const cut = mounted.button("cut");
    focus(cut);

    mounted.update({ ...completeState, canPaste: false, hasSelection: false });

    expect(document.activeElement).toBe(mounted.button("lock"));
    expect(mounted.button("lock").tabIndex).toBe(0);
    expect(cut.disabled).toBe(true);
    expect(cut.tabIndex).toBe(-1);
    expect(cut.getAttribute("aria-hidden")).toBe("true");

    void act(() => {
      cut.dispatchEvent(new Event("animationend", { bubbles: true }));
    });
    expect(mounted.container.contains(cut)).toBe(false);
    expect(document.activeElement).toBe(mounted.button("lock"));
    mounted.unmount();
  });
});

describe("mounted Inkbook flyout focus", () => {
  it("closes on Escape, consumes the key, and restores trigger focus", () => {
    const onFlyoutClose = vi.fn();
    const mounted = mountChrome(chromeProps(null, onFlyoutClose));
    mounted.update(chromeProps("background", onFlyoutClose));
    const dialog = requiredDialog();
    const choice = requiredElement<HTMLButtonElement>(dialog, "button");
    focus(choice);

    const escape = key(document, "Escape");

    expect(escape.defaultPrevented).toBe(true);
    expect(onFlyoutClose).toHaveBeenCalledWith("background");
    expect(document.activeElement).toBe(mounted.button("background"));
    expect(mounted.button("background").getAttribute("aria-expanded")).toBe("true");
    expect(mounted.button("background").getAttribute("aria-controls")).toBe(
      "inkbook-background-flyout",
    );
    mounted.unmount();
  });

  it("keeps a controlled closing flyout mounted and restores focus after its exit", () => {
    const mounted = mountChrome(chromeProps(null));
    mounted.update(chromeProps("shape"));
    const dialog = requiredDialog();
    focus(requiredElement<HTMLButtonElement>(dialog, "button"));

    mounted.update(chromeProps(null));
    expect(dialog.dataset.state).toBe("closing");
    expect(document.body.contains(dialog)).toBe(true);

    act(() => {
      dialog.dispatchEvent(
        new AnimationEvent("animationend", {
          animationName: "inkbook-flyout-exit",
          bubbles: true,
        }),
      );
    });

    expect(document.activeElement).toBe(mounted.button("shape"));
    expect(document.body.contains(dialog)).toBe(false);
    mounted.unmount();
  });
});

interface MountedToolbar {
  readonly button: (action: ToolbarAction) => HTMLButtonElement;
  readonly container: HTMLDivElement;
  readonly unmount: () => void;
  readonly update: (state: ToolbarState) => void;
}

interface MountedChrome {
  readonly button: (action: ToolbarAction) => HTMLButtonElement;
  readonly unmount: () => void;
  readonly update: (props: InkbookEditorChromeProps) => void;
}

function mountToolbar(initialState: ToolbarState): MountedToolbar {
  const container = document.body.createDiv();
  const root = createRoot(container);
  const render = (state: ToolbarState): void => {
    act(() => {
      root.render(
        <InkbookToolbar
          layout="wide"
          onAction={vi.fn()}
          renderIcon={(element, icon) => element.setAttribute("data-icon", icon)}
          state={state}
        />,
      );
    });
  };
  render(initialState);
  return {
    button: (action) => requiredButton(container, action),
    container,
    unmount: () => unmount(root),
    update: render,
  };
}

function mountChrome(initialProps: InkbookEditorChromeProps): MountedChrome {
  const container = document.body.createDiv();
  container.className = "inkbook-root";
  const root = createRoot(container);
  const render = (props: InkbookEditorChromeProps): void => {
    act(() => root.render(<InkbookEditorChrome {...props} />));
  };
  render(initialProps);
  return {
    button: (action) => requiredButton(container, action),
    unmount: () => unmount(root),
    update: render,
  };
}

function chromeProps(
  openFlyout: ToolbarState["openFlyout"],
  onFlyoutClose = vi.fn(),
): InkbookEditorChromeProps {
  return {
    background: { spacing: "m", type: "lines" },
    callbacks: {
      onBackgroundSpacingChange: vi.fn(),
      onBackgroundTypeChange: vi.fn(),
      onFlyoutClose,
      onShapeChange: vi.fn(),
      onStyleChange: vi.fn(),
    },
    canvasInput: document.body.createDiv(),
    layout: "wide",
    onToolbarAction: vi.fn(),
    ownerDocument: document,
    renderIcon: (element, icon) => element.setAttribute("data-icon", icon),
    selectedShape: "rectangle",
    styleControls: [],
    toolbarState: { ...completeState, openFlyout },
  };
}

function installCreateDiv(): void {
  document.body.createDiv = (options) => {
    const element = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    if (typeof options === "object" && options.cls !== undefined) {
      element.className = Array.isArray(options.cls) ? options.cls.join(" ") : options.cls;
    }
    document.body.append(element);
    return element;
  };
}

function requiredDialog(): HTMLDivElement {
  const dialog = document.body.querySelector<HTMLDivElement>(".inkbook-flyout[role='dialog']");
  if (dialog === null) throw new Error("Expected a mounted flyout dialog");
  return dialog;
}

function requiredElement<T extends Element>(container: Element, selector: string): T {
  const element = container.querySelector<T>(selector);
  if (element === null) throw new Error(`Expected ${selector}`);
  return element;
}

function requiredButton(container: HTMLElement, action: ToolbarAction): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`[data-inkbook-action='${action}']`);
  if (button === null) throw new Error(`Expected the ${action} toolbar button`);
  return button;
}

function groupTabStops(container: HTMLElement): number[] {
  return [...container.querySelectorAll<HTMLElement>("[role='group']")].map(
    (group) => group.querySelectorAll("button[tabindex='0']").length,
  );
}

function focus(element: HTMLElement): void {
  act(() => element.focus());
}

function key(element: EventTarget, value: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: value,
  });
  void act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

function unmount(root: Root): void {
  act(() => root.unmount());
}
