// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  InkbookEditorChrome,
  type InkbookEditorChromeProps,
} from "../../../../src/rendering/ui/editor-chrome";
import {
  SHAPE_ICON_IDS,
  STRAIGHT_HIGHLIGHTER_ICON_ID,
} from "../../../../src/rendering/ui/icon-ids";
import { InkbookToolbar } from "../../../../src/rendering/ui/toolbar";
import type { ToolbarStyleIconState } from "../../../../src/rendering/ui/style-icon";
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

const defaultStyleIcon: ToolbarStyleIconState = {
  fillColor: null,
  fillOpacity: 0,
  outlineColor: { type: "rgba", value: "#EF4444FF" },
  outlineStyle: "solid",
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
  it("moves one roving focus stop across the continuous track and leaves Tab unhandled", () => {
    const mounted = mountToolbar(completeState);
    const select = mounted.button("select");
    focus(select);

    expect(key(select, "ArrowRight").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(mounted.button("eraser"));
    expect(key(document.activeElement as HTMLElement, "End").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(mounted.button("overflow"));
    expect(key(document.activeElement as HTMLElement, "Home").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(mounted.button("finger-drawing"));
    expect(key(document.activeElement as HTMLElement, "ArrowLeft").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(mounted.button("overflow"));

    const tab = key(document.activeElement as HTMLElement, "Tab");
    expect(tab.defaultPrevented).toBe(false);
    expect(groupTabStops(mounted.container)).toEqual([1, 1]);
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
      "Tools and actions",
      "Editing actions",
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

  it("uses the registered ruler-marked highlighter icon for straight highlighting", () => {
    const mounted = mountToolbar(completeState);
    const icon = requiredElement<HTMLElement>(
      mounted.button("straight-highlighter"),
      ".inkbook-toolbar-icon",
    );

    expect(icon.dataset.icon).toBe(STRAIGHT_HIGHLIGHTER_ICON_ID);
    mounted.unmount();
  });
});

describe("mounted Inkbook toolbar motion and responsiveness", () => {
  it("staggers fixed-size contextual action pops without fading their surfaces", () => {
    const mounted = mountToolbar({
      ...completeState,
      canPaste: false,
      hasSelection: false,
    });

    mounted.update(completeState);

    expect(
      ["copy", "cut", "paste", "delete"].map((action) => ({
        order: mounted.button(action as ToolbarAction).dataset.presenceOrder,
        presence: mounted.button(action as ToolbarAction).dataset.presence,
      })),
    ).toEqual([
      { order: "0", presence: "entering" },
      { order: "1", presence: "entering" },
      { order: "2", presence: "entering" },
      { order: "3", presence: "entering" },
    ]);
    void act(() => {
      mounted.button("copy").dispatchEvent(new Event("animationend", { bubbles: true }));
    });
    expect(
      ["cut", "paste", "delete"].map(
        (action) => mounted.button(action as ToolbarAction).dataset.presenceOrder,
      ),
    ).toEqual(["1", "2", "3"]);
    mounted.unmount();
  });

  it("updates the active tool on stable 44-pixel controls without replacing their icons", () => {
    const mounted = mountToolbar(completeState);
    const draw = mounted.button("draw");
    const select = mounted.button("select");
    const indicator = requiredElement<HTMLSpanElement>(
      mounted.container,
      ".inkbook-toolbar-active-indicator",
    );
    const drawIcon = requiredElement<HTMLElement>(draw, ".inkbook-toolbar-icon");
    const selectIcon = requiredElement<HTMLElement>(select, ".inkbook-toolbar-icon");
    setButtonMetrics(draw, 196);
    mounted.update(completeState);
    expect(indicator.style.getPropertyValue("--inkbook-toolbar-active-offset")).toBe("200px");

    setButtonMetrics(select, 104);

    mounted.update({ ...completeState, activeTool: "select" });

    expect(requiredElement(mounted.container, ".inkbook-toolbar-active-indicator")).toBe(indicator);
    expect(indicator.style.getPropertyValue("--inkbook-toolbar-active-offset")).toBe("108px");
    expect(indicator.getAttribute("aria-hidden")).toBe("true");
    expect(mounted.button("draw")).toBe(draw);
    expect(mounted.button("select")).toBe(select);
    expect(draw.getAttribute("aria-pressed")).toBe("false");
    expect(select.getAttribute("aria-pressed")).toBe("true");
    expect(requiredElement(draw, ".inkbook-toolbar-icon")).toBe(drawIcon);
    expect(requiredElement(select, ".inkbook-toolbar-icon")).toBe(selectIcon);
    mounted.unmount();
  });

  it("keeps contextual actions in the same scrollable rail as the primary toolbar", () => {
    const mounted = mountToolbar(completeState, "scrollable");
    const composition = requiredElement<HTMLElement>(
      mounted.container,
      ".inkbook-toolbar-composition-scrollable",
    );
    const rail = requiredElement<HTMLElement>(composition, ".inkbook-toolbar-rail");
    const context = requiredElement<HTMLElement>(rail, ".inkbook-toolbar-context-actions");

    expect(rail.contains(mounted.button("delete"))).toBe(true);
    expect(context.previousElementSibling?.classList.contains("inkbook-toolbar-scrollable")).toBe(
      true,
    );
    mounted.unmount();
  });
});

describe("mounted Inkbook toolbar focus recovery", () => {
  it("keeps every exit slot until the staggered batch completes, then removes it atomically", () => {
    const mounted = mountToolbar({ ...completeState, canPaste: false });
    const copy = mounted.button("copy");
    const cut = mounted.button("cut");
    const deleteButton = mounted.button("delete");
    focus(cut);

    mounted.update({ ...completeState, canPaste: false, hasSelection: false });

    expect(document.activeElement).toBe(mounted.button("overflow"));
    expect(mounted.button("overflow").tabIndex).toBe(0);
    expect(cut.disabled).toBe(true);
    expect(cut.tabIndex).toBe(-1);
    expect(cut.getAttribute("aria-hidden")).toBe("true");

    void act(() => {
      copy.dispatchEvent(new Event("animationend", { bubbles: true }));
      cut.dispatchEvent(new Event("animationend", { bubbles: true }));
    });
    expect(mounted.container.contains(copy)).toBe(true);
    expect(mounted.container.contains(cut)).toBe(true);
    expect(mounted.container.contains(deleteButton)).toBe(true);
    void act(() => {
      deleteButton.dispatchEvent(new Event("animationend", { bubbles: true }));
    });
    expect(mounted.container.contains(copy)).toBe(false);
    expect(mounted.container.contains(cut)).toBe(false);
    expect(mounted.container.contains(deleteButton)).toBe(false);
    expect(document.activeElement).toBe(mounted.button("overflow"));
    mounted.unmount();
  });
});

describe("mounted Inkbook style control", () => {
  it("updates the style glyph in place when the active tool paint changes", () => {
    const mounted = mountToolbar(completeState);
    const button = mounted.button("style");
    const icon = requiredElement<SVGSVGElement>(button, ".inkbook-toolbar-style-icon svg");

    mounted.update(completeState, "rectangle", {
      fillColor: { type: "rgba", value: "#8B5CF6FF" },
      fillOpacity: 0.6,
      outlineColor: { type: "rgba", value: "#F97316FF" },
      outlineStyle: "dashed",
    });

    expect(mounted.button("style")).toBe(button);
    expect(requiredElement(button, ".inkbook-toolbar-style-icon svg")).toBe(icon);
    expect(icon.dataset.outlineStyle).toBe("dashed");
    expect(icon.dataset.fill).toBe("color");
    expect(icon.querySelector("path")?.getAttribute("stroke-dasharray")).toBe("3.4 2.4");
    expect(icon.querySelector("path")?.getAttribute("fill-opacity")).toBe("0.6");
    mounted.unmount();
  });
});

describe("mounted Inkbook shape controls", () => {
  it("shows the selected shape separately from its picker", () => {
    const mounted = mountToolbar(completeState);

    expect(
      requiredElement<HTMLElement>(mounted.button("shape"), ".inkbook-toolbar-icon").dataset.icon,
    ).toBe(SHAPE_ICON_IDS.rectangle);
    expect(mounted.button("shape").getAttribute("aria-label")).toBe("Shape: Rectangle");
    expect(mounted.button("shape").hasAttribute("aria-haspopup")).toBe(false);
    expect(mounted.button("shape-picker").getAttribute("aria-controls")).toBe(
      "inkbook-shape-flyout",
    );

    mounted.update(completeState, "triangle");
    expect(
      requiredElement<HTMLElement>(mounted.button("shape"), ".inkbook-toolbar-icon").dataset.icon,
    ).toBe(SHAPE_ICON_IDS.triangle);
    expect(mounted.button("shape").getAttribute("aria-label")).toBe("Shape: Triangle");
    mounted.unmount();
  });
});

describe("mounted Inkbook history controls", () => {
  it("retains disabled controls and skips them during roving keyboard navigation", () => {
    const mounted = mountToolbar({ ...completeState, canRedo: false, canUndo: false });
    const undo = mounted.button("undo");
    const redo = mounted.button("redo");
    const fingerDrawing = mounted.button("finger-drawing");

    expect(undo.disabled).toBe(true);
    expect(redo.disabled).toBe(true);
    expect(undo.tabIndex).toBe(-1);
    expect(redo.tabIndex).toBe(-1);

    focus(fingerDrawing);
    expect(key(fingerDrawing, "ArrowRight").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(mounted.button("select"));
    mounted.unmount();
  });
});

describe("mounted Inkbook flyout focus", () => {
  it("closes on Escape, consumes the key, and restores trigger focus", () => {
    const onFlyoutClose = vi.fn();
    const mounted = mountChrome(chromeProps(null, onFlyoutClose));
    mounted.update(chromeProps("shape", onFlyoutClose));
    const dialog = requiredDialog();
    const choice = requiredElement<HTMLButtonElement>(dialog, "button");
    focus(choice);

    const escape = key(document, "Escape");

    expect(escape.defaultPrevented).toBe(true);
    expect(onFlyoutClose).toHaveBeenCalledWith("shape");
    expect(document.activeElement).toBe(mounted.button("shape-picker"));
    expect(mounted.button("shape-picker").getAttribute("aria-expanded")).toBe("true");
    expect(mounted.button("shape-picker").getAttribute("aria-controls")).toBe(
      "inkbook-shape-flyout",
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

    expect(document.activeElement).toBe(mounted.button("shape-picker"));
    expect(document.body.contains(dialog)).toBe(false);
    mounted.unmount();
  });
});

interface MountedToolbar {
  readonly button: (action: ToolbarAction) => HTMLButtonElement;
  readonly container: HTMLDivElement;
  readonly unmount: () => void;
  readonly update: (
    state: ToolbarState,
    selectedShape?: "rectangle" | "triangle",
    styleIcon?: ToolbarStyleIconState,
  ) => void;
}

interface MountedChrome {
  readonly button: (action: ToolbarAction) => HTMLButtonElement;
  readonly unmount: () => void;
  readonly update: (props: InkbookEditorChromeProps) => void;
}

function mountToolbar(
  initialState: ToolbarState,
  layout: "wide" | "scrollable" = "wide",
): MountedToolbar {
  const container = document.body.createDiv();
  const root = createRoot(container);
  const render = (
    state: ToolbarState,
    selectedShape: "rectangle" | "triangle" = "rectangle",
    styleIcon: ToolbarStyleIconState = defaultStyleIcon,
  ): void => {
    act(() => {
      root.render(
        <InkbookToolbar
          layout={layout}
          onAction={vi.fn()}
          renderIcon={(element, icon) => element.setAttribute("data-icon", icon)}
          selectedShape={selectedShape}
          state={state}
          styleIcon={styleIcon}
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

function setButtonMetrics(button: HTMLButtonElement, offsetLeft: number): void {
  Object.defineProperties(button, {
    offsetLeft: { configurable: true, value: offsetLeft },
    offsetWidth: { configurable: true, value: 44 },
  });
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
      onOverflowAction: vi.fn(),
      onShapeChange: vi.fn(),
      onStyleChange: vi.fn(),
    },
    canvasInput: document.body.createDiv(),
    layout: "wide",
    onToolbarAction: vi.fn(),
    ownerDocument: document,
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
    renderIcon: (element, icon) => element.setAttribute("data-icon", icon),
    selectedShape: "rectangle",
    styleControls: [],
    styleIcon: { fillColor: null, fillOpacity: 0, outlineColor: null, outlineStyle: "solid" },
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
