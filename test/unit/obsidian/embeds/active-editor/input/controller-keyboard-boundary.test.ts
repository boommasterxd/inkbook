// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { INKBOOK_CLIPBOARD_WEB_MIME } from "../../../../../../src/persistence/clipboard/constants";
import { installObsidianDomHelpers } from "../../../../../adapters/obsidian/dom";
import { installNativeMenuMeasurementStyles } from "../../../../../adapters/obsidian/editor-toolbar-menu";
import {
  createHarness,
  createDiv,
  createButton,
  key,
  primaryPointer,
} from "../../../../../fixtures/obsidian/active-controller";

beforeEach(() => {
  installObsidianDomHelpers();
  installNativeMenuMeasurementStyles();
});

describe("active editor keyboard DOM boundary", () => {
  it("consumes hover zoom from the owning document without canvas focus", () => {
    const harness = createHarness();
    const toolbarButton = createDiv();
    toolbarButton.tabIndex = 0;
    document.body.append(toolbarButton);
    harness.input.dispatchEvent(new PointerEvent("pointerenter"));
    toolbarButton.focus();
    const zoom = key(toolbarButton, "+", { ctrlKey: true });
    expect(zoom.defaultPrevented).toBe(true);

    const editable = window.createEl("input");
    document.body.append(editable);
    editable.focus();
    expect(key(editable, "+", { ctrlKey: true }).defaultPrevented).toBe(false);

    harness.input.dispatchEvent(new PointerEvent("pointerleave"));
    toolbarButton.focus();
    expect(key(toolbarButton, "+", { ctrlKey: true }).defaultPrevented).toBe(false);
    toolbarButton.remove();
    editable.remove();
    harness.dispose();
  });

  it("consumes Shift+F10 and restores canvas focus when the native menu closes", async () => {
    const harness = createHarness();
    harness.input.focus();

    const event = harness.key("F10", { shiftKey: true });

    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(harness.menu.positions).toHaveLength(1));
    expect(harness.menu.positions).toEqual([
      { ownerDocument: document, position: { x: 400, y: 300 } },
    ]);
    harness.menu.close();
    expect(document.activeElement).toBe(harness.input);
    harness.dispose();
  });

  it.each(["disable", "dispose"] as const)(
    "releases a selection-handle pointer capture on %s",
    (cleanup) => {
      const harness = createHarness();
      harness.selectElement();
      harness.controller.handlePointerUp(primaryPointer());
      harness.capture.release.mockClear();
      harness.capture.set.mockClear();

      harness.controller.handlePointerDown(primaryPointer(50, 50));
      expect(harness.capture.set).toHaveBeenCalledWith(7);
      if (cleanup === "disable") harness.controller.setEnabled(false);
      else harness.dispose();

      expect(harness.capture.release).toHaveBeenCalledOnce();
      expect(harness.capture.release).toHaveBeenCalledWith(7);
      if (cleanup === "disable") harness.dispose();
    },
  );

  it("consumes Escape only while it closes the highest-priority active state", () => {
    const harness = createHarness();
    const trigger = createButton();
    document.body.append(trigger);
    harness.controller.handleToolbarAction("overflow", trigger);
    expect(harness.controller.chromeProps().toolbarState.openFlyout).toBe("overflow");

    expect(harness.key("Escape").defaultPrevented).toBe(true);
    expect(harness.controller.chromeProps().toolbarState.openFlyout).toBeNull();
    expect(harness.key("Escape").defaultPrevented).toBe(false);
    harness.dispose();
  });

  it("preserves native Copy and Delete while claiming direct canvas Paste for feedback", () => {
    const harness = createHarness();

    expect(harness.key("c", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(harness.key("x", { metaKey: true }).defaultPrevented).toBe(false);
    expect(harness.key("v", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(harness.key("Delete").defaultPrevented).toBe(false);
    expect(harness.paste(["text/html"], () => "<p>native</p>").defaultPrevented).toBe(true);
    expect(
      harness.paste([INKBOOK_CLIPBOARD_WEB_MIME], () => '{"format":"inkbook-elements"}')
        .defaultPrevented,
    ).toBe(true);
    harness.controller.handlePointerBoundary(true);
    expect(
      harness.paste([INKBOOK_CLIPBOARD_WEB_MIME], () => '{"format":"inkbook-elements"}')
        .defaultPrevented,
    ).toBe(true);
    harness.dispose();
  });
});

describe("active editor chrome callback boundary", () => {
  it("retains callback identities across semantic state snapshots", () => {
    const harness = createHarness();
    const first = harness.controller.chromeProps();
    const second = harness.controller.chromeProps();

    expect(second.onToolbarAction).toBe(first.onToolbarAction);
    harness.dispose();
  });
});

describe("active editor native paste DOM boundary", () => {
  it("does not consume a native Inkbook paste while editable text owns focus", () => {
    const harness = createHarness();
    const editable = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "textarea",
    ) as HTMLTextAreaElement;
    document.body.append(editable);
    harness.controller.handlePointerBoundary(true);
    editable.focus();

    expect(
      harness.paste([INKBOOK_CLIPBOARD_WEB_MIME], () => '{"format":"inkbook-elements"}')
        .defaultPrevented,
    ).toBe(false);

    editable.remove();
    harness.dispose();
  });

  it("consumes Delete when a canvas selection is active", () => {
    const harness = createHarness();
    harness.selectElement();
    expect(harness.controller.chromeProps().toolbarState.hasSelection).toBe(true);

    expect(harness.key("Delete").defaultPrevented).toBe(true);
    expect(harness.renderer.setElementFade).toHaveBeenCalledWith(expect.any(Array), 150);
    harness.dispose();
  });

  it("keeps a focused canvas Clipboard shortcut claimed after touch hover ends", () => {
    const harness = createHarness();
    harness.selectElement();

    expect(harness.key("c", { ctrlKey: true }).defaultPrevented).toBe(true);
    harness.controller.handlePointerBoundary(true);
    expect(harness.key("c", { ctrlKey: true }).defaultPrevented).toBe(true);
    harness.controller.handlePointerBoundary(false);
    expect(harness.key("c", { ctrlKey: true }).defaultPrevented).toBe(true);
    harness.dispose();
  });
});

describe("active editor document keyboard boundary", () => {
  it("claims Selection shortcuts after canvas focus moves to a toolbar button", () => {
    const harness = createHarness();
    const toolbarButton = document.body.appendChild(createButton());
    harness.selectElement();
    harness.input.dispatchEvent(new PointerEvent("pointerenter"));
    toolbarButton.focus();

    expect(key(toolbarButton, "Delete", {}).defaultPrevented).toBe(true);
    toolbarButton.remove();
    harness.dispose();
  });

  it("opens the owned overflow menu centered below its toolbar trigger", () => {
    const harness = createHarness();
    const trigger = createButton();
    document.body.append(trigger);
    trigger.getBoundingClientRect = () =>
      ({ bottom: 144, height: 44, left: 320, right: 364, top: 100, width: 44 }) as DOMRect;

    harness.controller.handleToolbarAction("overflow", trigger);
    expect(harness.controller.chromeProps().toolbarState.openFlyout).toBe("overflow");
    expect(harness.menu.positions).toEqual([
      {
        ownerDocument: document,
        position: { centered: true, width: 44, x: 320, y: 146 },
      },
    ]);
    harness.menu.close();
    expect(harness.controller.chromeProps().toolbarState.openFlyout).toBeNull();
    expect(document.activeElement).toBe(trigger);

    harness.dispose();
  });

  it("removes an owned Style panel before opening a native toolbar menu", () => {
    const harness = createHarness();
    const styleTrigger = createButton();
    const overflowTrigger = createButton();
    document.body.append(styleTrigger, overflowTrigger);

    harness.controller.handleToolbarAction("style", styleTrigger);
    expect(document.querySelector('.inkbook-adaptive-panel[data-kind="style"]')).not.toBeNull();

    harness.controller.handleToolbarAction("overflow", overflowTrigger);

    expect(document.querySelector(".inkbook-adaptive-panel")).toBeNull();
    expect(harness.menu.positions).toHaveLength(1);
    expect(harness.controller.chromeProps().toolbarState.openFlyout).toBe("overflow");
    harness.dispose();
  });

  it("reprojects screen-space selection geometry before each camera flush", () => {
    const harness = createHarness();
    harness.selectElement();
    const { setSelectionOverlayPath: setSelectionPath, flushPointerFeedbackFrame: flush } =
      harness.renderer;
    const initialPath = setSelectionPath.mock.lastCall?.[0];
    const order: string[] = [];
    setSelectionPath.mockImplementation(() => order.push("selection"));
    flush.mockImplementation(() => order.push("flush"));

    harness.controller.setZoom(2);

    expect(setSelectionPath.mock.lastCall?.[0]).not.toBe(initialPath);
    expect(order).toEqual(["selection", "flush"]);
    harness.dispose();
  });
});

describe("active eraser navigation boundary", () => {
  it.each(["release", "cancel"] as const)(
    "keeps the eraser radius stable until %s and then restores zoom",
    async (finish) => {
      vi.useFakeTimers();
      const harness = createHarness();
      try {
        harness.controller.handleToolbarAction("eraser");
        harness.controller.handlePointerBoundary(true);
        harness.controller.handlePointerDown(primaryPointer(400, 400));
        harness.renderer.setCamera.mockClear();
        harness.renderer.setViewport.mockClear();
        expect(harness.key("+", { ctrlKey: true }).defaultPrevented).toBe(true);
        const wheel = new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, cancelable: true });
        harness.controller.handleWheel(wheel);
        expect(wheel.defaultPrevented).toBe(true);
        await vi.advanceTimersByTimeAsync(32);
        expect(harness.renderer.setCamera).not.toHaveBeenCalled();
        expect(harness.renderer.setViewport).not.toHaveBeenCalled();
        if (finish === "release") harness.controller.handlePointerUp(primaryPointer(400, 400));
        else harness.controller.handlePointerCancel(primaryPointer(400, 400));
        harness.renderer.setCamera.mockClear();
        expect(harness.key("+", { ctrlKey: true }).defaultPrevented).toBe(true);
        await vi.advanceTimersByTimeAsync(32);
        expect(harness.renderer.setCamera).toHaveBeenCalled();
        expect(harness.renderer.setViewport).toHaveBeenCalledOnce();
        const viewport = harness.renderer.setViewport.mock.lastCall?.[0];
        expect(viewport).toMatchObject({ left: 0, top: document.body.scrollTop, width: 800 });
        expect(viewport?.height).toBeGreaterThan(0);
        expect(viewport?.height).toBeLessThanOrEqual(600);
      } finally {
        harness.dispose();
        vi.useRealTimers();
      }
    },
  );
});

describe("suppressed pen contact cleanup", () => {
  it.each(["escape", "blur"] as const)("releases retained capture on %s", async (cleanup) => {
    const harness = createHarness();
    const event = (buttons: number) =>
      new PointerEvent("pointermove", {
        pointerId: 7,
        pointerType: "pen",
        button: -1,
        buttons,
        pressure: 0.5,
        clientX: 700,
        clientY: 300,
      });
    harness.controller.handlePointerMove(event(5));
    harness.controller.handlePointerMove(event(1));
    expect(harness.capture.set).toHaveBeenCalledWith(7);
    expect(harness.capture.release).not.toHaveBeenCalled();
    if (cleanup === "escape") {
      await vi.waitFor(() => expect(harness.key("Escape").defaultPrevented).toBe(true));
    } else harness.controller.recoverInterruptedTouch();
    expect(harness.capture.release).toHaveBeenCalledWith(7);
    harness.dispose();
  });
});
