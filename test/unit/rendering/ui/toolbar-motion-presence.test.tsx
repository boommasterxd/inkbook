// @vitest-environment happy-dom

import { MotionGlobalConfig, processFrame } from "motion";
import { EventTarget as HappyEventTarget } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { InkbookEditorChrome } from "../../../../src/rendering/ui/editor-chrome";
import type { InkbookEditorChromeProps } from "../../../../src/rendering/ui/editor-chrome";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { createEditorChromeProps } from "../../../fixtures/editor-chrome";
import * as ChromePalette from "../../../../src/rendering/ui/chrome-palette";

const reactEnvironment = window as Window & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const mountedRoots = new Set<() => void>();
let motionTime = 0;

beforeAll(() => {
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
});
beforeEach(() => {
  installObsidianDomHelpers();
  MotionGlobalConfig.useManualTiming = true;
  motionTime = 0;
  processFrame(0);
});
afterEach(() => {
  for (const unmount of mountedRoots) unmount();
  mountedRoots.clear();
  MotionGlobalConfig.useManualTiming = false;
  document.body.replaceChildren();
  document.body.classList.remove("theme-dark");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Motion toolbar primary touch target", () => {
  it("keeps a 44px primary touch target through preparation, ready, reduced motion and lock", async () => {
    const mounted = mountSelectedToolbar(true);
    const draw = mounted.button("draw");
    const expectTouchTarget = (): void => {
      expect(draw.style.width).toBe("44px");
      expect(draw.style.flexBasis).toBe("44px");
    };
    await advanceMotionBy(16);
    expectTouchTarget();

    mounted.presentation.classList.remove("inkbook-active-preparing");
    await flushRootMutation();
    await advanceMotionBy(400);
    expect(draw.disabled).toBe(false);
    expectTouchTarget();

    mounted.presentation.dataset.inkbookMotion = "reduced";
    await flushRootMutation();
    expectTouchTarget();

    mounted.presentation.dataset.inkbookState = "locking";
    await flushRootMutation();
    expect(draw.disabled).toBe(true);
    expectTouchTarget();
    mounted.unmount();
  });
});

describe("Motion toolbar glyph lifecycle", () => {
  it("retains focused actions and current semantics through rapid glyph changes and reduced motion", async () => {
    const mounted = mountSelectedToolbar();
    const select = mounted.button("select");
    const shape = mounted.button("shape");
    act(() => select.focus());
    const rectangle = select.querySelector(".inkbook-toolbar-icon")!;

    mounted.setChromeProps({ selectionArea: "lasso" });
    expect(select.getAttribute("aria-label")).toBe("Select: Lasso");
    expect(select.contains(rectangle)).toBe(true);
    expect(select.querySelectorAll(".inkbook-toolbar-icon")).toHaveLength(2);
    mounted.setChromeProps({ selectionArea: "rectangle" });
    await advanceMotionBy(200);
    expect(select.querySelectorAll(".inkbook-toolbar-icon")).toHaveLength(1);
    expect(select.querySelector(".inkbook-toolbar-icon")).toBe(rectangle);
    expect(document.activeElement).toBe(select);

    for (const coordinateDimension of ["2d", "3d", "2d"] as const) {
      mounted.setChromeProps({
        selectedShape: "coordinate-system",
        shapeIcon: { arrowEnd: "arrow", arrowStart: "none", coordinateDimension },
      });
      expect(shape.getAttribute("aria-label")).toBe("Shape: Coordinate system");
    }
    expect(mounted.button("shape")).toBe(shape);
    mounted.presentation.dataset.inkbookMotion = "reduced";
    await flushRootMutation();
    expect(shape.querySelectorAll(".inkbook-toolbar-icon")).toHaveLength(1);
    expect(select.querySelectorAll(".inkbook-toolbar-icon")).toHaveLength(1);
    expect(select.querySelector(".inkbook-toolbar-icon")?.getAttribute("aria-hidden")).toBe("true");
    mounted.unmount();
    await advanceMotionBy(200);
    expect(mounted.container.childElementCount).toBe(0);
  });
});

describe("Motion toolbar color continuity", () => {
  it("preserves stylesheet overrides through interpolated hover, theme changes and quick returns", async () => {
    vi.stubGlobal("EventTarget", HappyEventTarget);
    let colors: ChromePalette.ChromeColors = {
      accent: "rgba(120, 80, 200, 1)",
      danger: "rgba(200, 40, 40, 1)",
      faint: "rgba(80, 80, 80, 1)",
      muted: "rgba(40, 40, 40, 1)",
      activeBackground: "rgba(120, 80, 200, 0.14)",
      activeBorder: "rgba(120, 80, 200, 0.45)",
      dangerHover: "rgba(200, 40, 40, 0.12)",
      hover: "rgba(0, 0, 0, 0.067)",
    };
    vi.spyOn(ChromePalette, "createChromePalette").mockReturnValue({
      read: () => colors,
      dispose: () => undefined,
    });
    const warnings = vi.spyOn(console, "warn");
    const mounted = mountSelectedToolbar();
    const snippet = document.createElementNS("http://www.w3.org/1999/xhtml", "style");
    snippet.textContent = `
      .inkbook-root .inkbook-toolbar-button { color: rebeccapurple; }
      .inkbook-root .inkbook-toolbar-button-surface {
        background-color: rebeccapurple;
        border-color: rebeccapurple;
      }
    `;
    mounted.presentation.prepend(snippet);
    const state = {
      ...createEditorChromeProps(document).toolbarState,
      canUndo: true,
      fingerDrawingAvailable: true,
    };
    mounted.setChromeProps({ toolbarState: state });
    await advanceMotionBy(400);
    const finger = mounted.button("finger-drawing");
    const surface = finger.querySelector<HTMLElement>(".inkbook-toolbar-button-surface")!;
    const snippetForeground = getComputedStyle(finger).color;
    const snippetBackground = getComputedStyle(surface).backgroundColor;
    const snippetBorder = getComputedStyle(surface).borderColor;
    const background = (): string => surface.style.getPropertyValue("--inkbook-toolbar-background");
    act(() => finger.focus());
    mouse(finger, "pointerenter");
    await advanceMotionBy(64);
    expect(background()).not.toBe(ChromePalette.CHROME_TRANSPARENT);
    expect(background()).not.toBe(colors.hover);
    expect(getComputedStyle(surface).backgroundColor).toBe(snippetBackground);
    mouse(finger, "pointerleave");
    await advanceMotionBy(16);
    mouse(finger, "pointerenter");
    mounted.setChromeProps({ toolbarState: { ...state, fingerDrawingEnabled: true } });
    expect(finger.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(finger);
    await advanceMotionBy(64);
    const foreground = finger.style.getPropertyValue("--inkbook-toolbar-foreground");
    expect(foreground).toMatch(/^rgba?\(/);
    expect(foreground).not.toBe(colors.muted);
    expect(foreground).not.toBe(colors.accent);
    colors = {
      ...colors,
      accent: "rgba(40, 160, 220, 1)",
      activeBackground: "rgba(40, 160, 220, 0.14)",
      activeBorder: "rgba(40, 160, 220, 0.45)",
      hover: "rgba(255, 255, 255, 0.12)",
    };
    document.body.classList.add("theme-dark");
    await flushRootMutation();
    await advanceMotionBy(400);
    expect(background()).toBe(colors.hover);
    mouse(finger, "pointerleave");
    await advanceMotionBy(400);
    expect(background()).toBe(colors.activeBackground);
    expect(getComputedStyle(finger).color).toBe(snippetForeground);
    expect(getComputedStyle(surface).borderColor).toBe(snippetBorder);
    expect(mounted.button("finger-drawing")).toBe(finger);
    expect(document.activeElement).toBe(finger);

    const undo = mounted.button("undo");
    mouse(undo, "pointerenter");
    mouse(undo, "pointerdown");
    await advanceMotionBy(32);
    mounted.setChromeProps({ toolbarState: { ...state, canUndo: false } });
    expect(undo.disabled).toBe(true);
    expect(undo.tabIndex).toBe(-1);
    mouse(window, "pointerup");
    mouse(undo, "pointerleave");
    await advanceMotionBy(400);
    expect(
      undo
        .querySelector<HTMLElement>(".inkbook-toolbar-button-surface")!
        .style.getPropertyValue("--inkbook-toolbar-background"),
    ).toBe(ChromePalette.CHROME_TRANSPARENT);
    expect(
      warnings.mock.calls.filter((args) =>
        /not.*animat|animat.*not|mix.*color/i.test(args.join(" ")),
      ),
    ).toEqual([]);
    mounted.unmount();
  });
});

function mouse(target: EventTarget, type: string): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, { button: 0, isPrimary: true, pointerId: 1, pointerType: "mouse" }),
    );
  });
}

describe("Motion toolbar presence", () => {
  it("keeps one root lifecycle observer across updates and releases it on unmount", () => {
    const observe = vi.spyOn(window.MutationObserver.prototype, "observe");
    const disconnect = vi.spyOn(window.MutationObserver.prototype, "disconnect");
    try {
      const mounted = mountSelectedToolbar();
      for (let update = 0; update < 10; update += 1) mounted.setSelection(true);
      const observers = observe.mock.calls.flatMap(([target], index) =>
        target === mounted.presentation ? [observe.mock.instances[index]] : [],
      );
      expect(observers).toHaveLength(1);

      mounted.unmount();
      expect(disconnect.mock.instances).toContain(observers[0]);
    } finally {
      observe.mockRestore();
      disconnect.mockRestore();
    }
  });

  it("retains every non-interactive exit slot until the last staggered control finishes", async () => {
    const mounted = mountSelectedToolbar();
    const buttons = ["copy", "cut", "delete"].map((action) => mounted.button(action));
    await advanceMotionBy(400);
    expect(buttons.every((button) => !button.style.transform.includes("scale(0)"))).toBe(true);

    mounted.setSelection(false);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      expect(button.tabIndex).toBe(-1);
      expect(button.getAttribute("aria-hidden")).toBe("true");
    }

    await advanceMotionBy(240);
    expect(buttons.map((button) => mounted.container.contains(button))).toEqual([true, true, true]);
    await advanceMotionBy(160);
    expect(buttons.every((button) => mounted.container.contains(button))).toBe(false);
    mounted.unmount();
  });

  it("keeps an interrupted exit mounted when the action returns", async () => {
    const mounted = mountSelectedToolbar();
    const copy = mounted.button("copy");
    await advanceMotionBy(400);

    mounted.setSelection(false);
    mounted.setSelection(true);
    await advanceMotionBy(400);

    expect(mounted.button("copy")).toBe(copy);
    expect(copy.disabled).toBe(false);
    mounted.unmount();
  });

  it("finishes pending exits with the whole toolbar during locking", async () => {
    const mounted = mountSelectedToolbar();
    const copy = mounted.button("copy");
    const draw = mounted.button("draw");
    await advanceMotionBy(400);
    mounted.setSelection(false);
    expect(draw.disabled).toBe(false);

    mounted.presentation.dataset.inkbookState = "locking";
    await act(async () => {
      await new Promise<void>((resolve) => window.queueMicrotask(resolve));
    });
    expect(draw.disabled).toBe(true);
    expect(copy.disabled).toBe(true);
    expect(copy.tabIndex).toBe(-1);

    await advanceMotionBy(240);
    expect(mounted.container.contains(copy)).toBe(false);
    mounted.unmount();
  });

  it("completes pending exits when reduced motion is enabled live", async () => {
    const mounted = mountSelectedToolbar();
    const copy = mounted.button("copy");
    await advanceMotionBy(400);
    mounted.setSelection(false);
    expect(mounted.container.contains(copy)).toBe(true);

    mounted.presentation.dataset.inkbookMotion = "reduced";
    await act(async () => {
      await new Promise<void>((resolve) => window.queueMicrotask(resolve));
    });
    await advanceMotionBy(32);

    expect(mounted.container.contains(copy)).toBe(false);
    mounted.unmount();
  });
});

async function advanceMotionBy(duration: number): Promise<void> {
  const endTime = motionTime + duration;
  while (motionTime < endTime) {
    motionTime = Math.min(endTime, motionTime + 16);
    await act(async () => {
      processFrame(motionTime);
      await Promise.resolve();
    });
  }
  await act(async () => {
    await Promise.resolve();
  });
}

async function flushRootMutation(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => window.queueMicrotask(resolve));
  });
}

function mountSelectedToolbar(preparing = false) {
  const presentation = document.body.createDiv({ cls: "inkbook-root" });
  presentation.dataset.inkbookMotion = "full";
  if (preparing) presentation.classList.add("inkbook-active-preparing");
  const container = presentation.createDiv();
  const root = createRoot(container);
  let props = createEditorChromeProps(document);
  const render = (hasSelection: boolean): void => {
    act(() => {
      root.render(
        <InkbookEditorChrome {...props} toolbarState={{ ...props.toolbarState, hasSelection }} />,
      );
    });
  };
  render(true);
  const unmount = (): void => {
    act(() => root.unmount());
    mountedRoots.delete(unmount);
  };
  mountedRoots.add(unmount);
  return {
    button: (action: string) => {
      const button = container.querySelector<HTMLButtonElement>(
        `[data-inkbook-action='${action}']`,
      );
      if (button === null) throw new Error(`Missing ${action} button`);
      return button;
    },
    container,
    presentation,
    setChromeProps: (changes: Partial<InkbookEditorChromeProps>): void => {
      props = { ...props, ...changes };
      render(true);
    },
    setSelection: render,
    unmount,
  };
}
