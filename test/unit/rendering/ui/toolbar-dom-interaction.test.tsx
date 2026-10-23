// @vitest-environment happy-dom

import { MotionGlobalConfig, processFrame } from "motion";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  arrowShapeIconId,
  SELECTION_AREA_ICON_IDS,
  SHAPE_ICON_IDS,
  STRAIGHT_HIGHLIGHTER_ICON_ID,
  type ActiveShapeIconState,
} from "../../../../src/rendering/ui/icon-ids";
import { InkbookEditorChrome } from "../../../../src/rendering/ui/editor-chrome";
import type { ToolbarStyleIconState } from "../../../../src/rendering/ui/style-icon";
import type { ToolbarAction, ToolbarState } from "../../../../src/rendering/ui/toolbar-types";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

const completeState: ToolbarState = {
  activeTool: "draw",
  canPaste: true,
  canRedo: true,
  canUndo: true,
  fingerDrawingAvailable: true,
  fingerDrawingEnabled: false,
  hasSelection: true,
  openFlyout: null,
  pasteVisible: true,
};
const noPasteState: ToolbarState = { ...completeState, canPaste: false, pasteVisible: false };

const defaultStyleIcon: ToolbarStyleIconState = {
  fillColor: null,
  fillOpacity: 0,
  outlineColor: { type: "rgba", value: "#EF4444FF" },
  outlineStyle: "solid",
};

const defaultShapeIcon = {
  arrowEnd: "arrow" as const,
  arrowStart: "none" as const,
  coordinateDimension: "2d" as const,
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

beforeEach(() => {
  installObsidianDomHelpers();
  MotionGlobalConfig.useManualTiming = true;
  processFrame(0);
});

afterEach(() => {
  MotionGlobalConfig.useManualTiming = false;
  document.body.replaceChildren();
});

describe("mounted Inkbook toolbar accessibility", () => {
  it("moves one roving focus stop across the continuous track and leaves Tab unhandled", () => {
    const mounted = mountToolbar(completeState, "scrollable");
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

  it("provides host tooltip labels without competing browser title tooltips", () => {
    const mounted = mountToolbar({ ...completeState, canPaste: false });
    const toolbar = mounted.container.querySelector<HTMLElement>("[role='toolbar']");
    const groups = mounted.container.querySelectorAll<HTMLElement>("[role='group']");
    const buttons =
      mounted.container.querySelectorAll<HTMLButtonElement>(".inkbook-toolbar-button");

    expect(toolbar?.getAttribute("aria-label")).toBe("Inkbook tools");
    expect([...groups].map((group) => group.getAttribute("aria-label"))).toEqual([
      "Tools and actions",
      "Editing actions",
    ]);
    for (const button of buttons) {
      const name = button.getAttribute("aria-label");
      expect(name).toBeTruthy();
      expect(button.hasAttribute("title")).toBe(false);
      expect(button.querySelector(".inkbook-toolbar-icon")?.getAttribute("aria-hidden")).toBe(
        "true",
      );
    }
    expect(mounted.button("draw").getAttribute("aria-pressed")).toBe("true");
    expect(mounted.button("paste").disabled).toBe(false);
    const icon = requiredElement<HTMLElement>(
      mounted.button("straight-highlighter"),
      ".inkbook-toolbar-icon",
    );

    expect(icon.dataset.icon).toBe(STRAIGHT_HIGHLIGHTER_ICON_ID);
    mounted.unmount();
  });

  it("updates the Select icon and accessible name with the active selection area", () => {
    const mounted = mountToolbar(completeState);
    const select = mounted.button("select");
    const icon = requiredElement<HTMLElement>(select, ".inkbook-toolbar-icon");

    expect(icon.dataset.icon).toBe(SELECTION_AREA_ICON_IDS.rectangle);
    expect(select.getAttribute("aria-label")).toBe("Select: Rectangle");

    mounted.update(completeState, "rectangle", defaultStyleIcon, defaultShapeIcon, "lasso");

    expect(mounted.button("select")).toBe(select);
    expect(requiredElement(select, ".inkbook-toolbar-icon")).not.toBe(icon);
    expect(requiredElement<HTMLElement>(select, ".inkbook-toolbar-icon").dataset.icon).toBe(
      SELECTION_AREA_ICON_IDS.lasso,
    );
    expect(select.getAttribute("aria-label")).toBe("Select: Lasso");
    mounted.unmount();
  });
});

describe("mounted Inkbook toolbar action confirmation", () => {
  it("switches a confirmed context action to a check without replacing its button", () => {
    const mounted = mountToolbar(completeState);
    const copy = mounted.button("copy");

    mounted.update({
      ...completeState,
      actionConfirmation: { action: "copy", sequence: 1 },
    });

    const icon = requiredElement<HTMLElement>(copy, ".inkbook-toolbar-action-icon");
    expect(mounted.button("copy")).toBe(copy);
    expect(icon.dataset.confirmed).toBe("true");
    expect(
      requiredElement<HTMLElement>(copy, ".inkbook-toolbar-action-icon-default").dataset.icon,
    ).toBe("copy");
    expect(
      requiredElement<HTMLElement>(copy, ".inkbook-toolbar-action-icon-confirmation").dataset.icon,
    ).toBe("check");

    mounted.update({ ...completeState, actionConfirmation: null });
    expect(
      requiredElement<HTMLElement>(copy, ".inkbook-toolbar-action-icon").dataset.confirmed,
    ).toBeUndefined();
    mounted.unmount();
  });
});

describe("mounted Inkbook toolbar responsiveness", () => {
  it("keeps tool controls usable when the active tool changes", () => {
    const mounted = mountToolbar(completeState);
    const draw = mounted.button("draw");
    const select = mounted.button("select");
    focus(draw);

    mounted.update({ ...completeState, activeTool: "select" });

    expect(mounted.button("draw")).toBe(draw);
    expect(mounted.button("select")).toBe(select);
    expect(document.activeElement).toBe(draw);
    expect(draw.getAttribute("aria-pressed")).toBe("false");
    expect(select.getAttribute("aria-pressed")).toBe("true");
    act(() => select.click());
    expect(mounted.onAction).toHaveBeenLastCalledWith("select", select);
    mounted.unmount();
  });
});

describe("mounted Inkbook toolbar focus recovery", () => {
  it.each([false, true])(
    "returns focus correctly after a context exit, leftHanded=%s",
    async (leftHanded) => {
      const mounted = mountToolbar(noPasteState, "wide", leftHanded);
      const copy = mounted.button("copy");
      const cut = mounted.button("cut");
      const deleteButton = mounted.button("delete");
      focus(cut);
      if (leftHanded) {
        key(cut, "ArrowRight");
        expect(document.activeElement).toBe(copy);
        focus(cut);
      }

      mounted.update({ ...noPasteState, hasSelection: false });

      const fallback = mounted.button(leftHanded ? "finger-drawing" : "overflow");
      expect(document.activeElement).toBe(fallback);
      expect(fallback.tabIndex).toBe(0);
      expect(cut.disabled).toBe(true);
      expect(cut.tabIndex).toBe(-1);
      expect(cut.getAttribute("aria-hidden")).toBe("true");

      await act(async () => {
        await Promise.resolve();
      });
      expect(mounted.container.contains(copy)).toBe(false);
      expect(mounted.container.contains(cut)).toBe(false);
      expect(mounted.container.contains(deleteButton)).toBe(false);
      expect(document.activeElement).toBe(fallback);
      mounted.unmount();
    },
  );
});

describe("mounted Inkbook toolbar lifecycle", () => {
  it("makes context actions unavailable as soon as editor locking starts", async () => {
    const mounted = mountToolbar(noPasteState);
    const copy = mounted.button("copy");
    focus(copy);

    mounted.presentation.dataset.inkbookState = "locking";
    await act(async () => {
      await Promise.resolve();
    });

    expect(copy.disabled).toBe(true);
    expect(copy.tabIndex).toBe(-1);
    expect(copy.getAttribute("aria-hidden")).toBe("true");
    mounted.unmount();
  });
});

describe("mounted Inkbook style control", () => {
  it("retains the focused Style action while its tool paint changes repeatedly", async () => {
    const mounted = mountToolbar(completeState);
    const button = mounted.button("style");
    const icon = requiredElement<SVGSVGElement>(button, ".inkbook-toolbar-style-icon svg");
    focus(button);
    const paint: ToolbarStyleIconState = {
      fillColor: { type: "rgba", value: "#8B5CF6FF" },
      fillOpacity: 0.6,
      outlineColor: { type: "rgba", value: "#F97316FF" },
      outlineStyle: "dashed",
    };

    for (const state of [
      paint,
      { ...paint, outlineStyle: "dotted" as const },
      { ...defaultStyleIcon, outlineColor: null },
    ]) {
      mounted.update(completeState, "rectangle", state);
      await act(async () => {
        processFrame(16);
        await Promise.resolve();
      });
      expect(mounted.button("style")).toBe(button);
      expect(requiredElement(button, ".inkbook-toolbar-style-icon svg")).toBe(icon);
      expect(document.activeElement).toBe(button);
      expect(button.getAttribute("aria-label")).toBe("Style");
    }
    act(() => button.click());
    expect(mounted.onAction).toHaveBeenLastCalledWith("style", button);
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
    expect(mounted.button("shape-picker").getAttribute("aria-haspopup")).toBe("menu");
    expect(mounted.button("style").getAttribute("aria-haspopup")).toBe("dialog");
    expect(mounted.button("style").getAttribute("aria-expanded")).toBe("false");

    const shapePicker = mounted.button("shape-picker");
    act(() => shapePicker.click());
    expect(mounted.onAction).toHaveBeenLastCalledWith("shape-picker", shapePicker);
    mounted.update({ ...completeState, openFlyout: "shape" }, "triangle");
    expect(
      requiredElement<HTMLElement>(mounted.button("shape"), ".inkbook-toolbar-icon").dataset.icon,
    ).toBe(SHAPE_ICON_IDS.triangle);
    expect(mounted.button("shape").getAttribute("aria-label")).toBe("Shape: Triangle");
    expect(shapePicker.getAttribute("aria-expanded")).toBe("true");
    const style = mounted.button("style");
    act(() => style.click());
    expect(mounted.onAction).toHaveBeenLastCalledWith("style", style);
    mounted.update({ ...completeState, openFlyout: "style" }, "triangle");
    expect(style.getAttribute("aria-expanded")).toBe("true");
    expect(shapePicker.getAttribute("aria-expanded")).toBe("false");
    mounted.unmount();
  });

  it("updates the active arrow icon when either endpoint style changes", () => {
    const mounted = mountToolbar(completeState);
    for (const [arrowStart, arrowEnd] of [
      ["none", "arrow"],
      ["triangle", "arrow"],
      ["triangle", "circle"],
    ] as const) {
      mounted.update(completeState, "arrow", defaultStyleIcon, {
        arrowEnd,
        arrowStart,
        coordinateDimension: "2d",
      });
      expect(
        requiredElement<HTMLElement>(mounted.button("shape"), ".inkbook-toolbar-icon").dataset.icon,
      ).toBe(arrowShapeIconId(arrowStart, arrowEnd));
    }
    mounted.unmount();
  });
});

describe("mounted Inkbook history controls", () => {
  it("retains disabled controls and skips them during roving keyboard navigation", () => {
    const mounted = mountToolbar({
      ...noPasteState,
      canRedo: false,
      canUndo: true,
      fingerDrawingAvailable: false,
      hasSelection: false,
    });
    const undo = mounted.button("undo");
    const redo = mounted.button("redo");
    expect(undo.disabled).toBe(false);
    expect(undo.tabIndex).toBe(0);
    expect(mounted.button("select").tabIndex).toBe(-1);
    for (const label of ["Copy", "Paste", "Finger drawing"]) {
      expect(mounted.container.querySelector(`button[aria-label='${label}']`)).toBeNull();
    }
    mounted.update({ ...completeState, canRedo: false, canUndo: false });
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

interface MountedToolbar {
  readonly button: (action: ToolbarAction) => HTMLButtonElement;
  readonly container: HTMLDivElement;
  readonly onAction: (action: ToolbarAction, trigger: HTMLButtonElement) => void;
  readonly presentation: HTMLDivElement;
  readonly unmount: () => void;
  readonly update: (
    state: ToolbarState,
    selectedShape?: "arrow" | "rectangle" | "triangle",
    styleIcon?: ToolbarStyleIconState,
    shapeIcon?: ActiveShapeIconState,
    selectionArea?: "lasso" | "rectangle",
  ) => void;
}

function mountToolbar(
  initialState: ToolbarState,
  layout: "wide" | "scrollable" = "wide",
  leftHanded = false,
): MountedToolbar {
  const presentation = document.body.createDiv({ cls: "inkbook-root" });
  presentation.dataset.inkbookMotion = "reduced";
  const container = presentation.createDiv();
  const root = createRoot(container);
  const onAction = vi.fn<(action: ToolbarAction, trigger: HTMLButtonElement) => void>();
  const render = (
    state: ToolbarState,
    selectedShape: "arrow" | "rectangle" | "triangle" = "rectangle",
    styleIcon: ToolbarStyleIconState = defaultStyleIcon,
    shapeIcon: ActiveShapeIconState = defaultShapeIcon,
    selectionArea: "lasso" | "rectangle" = "rectangle",
  ): void => {
    act(() => {
      root.render(
        <InkbookEditorChrome
          layout={layout}
          leftHanded={leftHanded}
          onToolbarAction={onAction}
          ownerDocument={document}
          renderIcon={(element, icon) => element.setAttribute("data-icon", icon)}
          selectionArea={selectionArea}
          selectedShape={selectedShape}
          shapeIcon={shapeIcon}
          toolbarState={state}
          styleIcon={styleIcon}
        />,
      );
    });
  };
  render(initialState);
  return {
    button: (action) =>
      requiredElement<HTMLButtonElement>(container, `[data-inkbook-action='${action}']`),
    container,
    onAction,
    presentation,
    unmount: () => act(() => root.unmount()),
    update: render,
  };
}

function requiredElement<T extends Element>(container: Element, selector: string): T {
  const element = container.querySelector<T>(selector);
  if (element === null) throw new Error(`Expected ${selector}`);
  return element;
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
