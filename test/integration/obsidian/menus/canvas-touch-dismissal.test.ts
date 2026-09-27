// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { CanvasTouchBoundary } from "../../../../src/obsidian/embeds/canvas-touch-boundary";
import { AdaptivePanelSession } from "../../../../src/obsidian/menus/adaptive-panel";
import { createOwnedMenuFactory } from "../../../../src/obsidian/menus/owned-menu-factory";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

beforeEach(() => {
  installObsidianDomHelpers();
  vi.useFakeTimers();
});
afterEach(() => {
  Platform.isMobile = false;
  Platform.isPhone = false;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe.each(["desktop", "tablet", "phone"])("%s canvas menu touch dismissal", (mode) => {
  it.each(["style", "background", "shape", "overflow", "context"] as const)(
    "dismisses %s before canvas input and releases the listener",
    (kind) => {
      Platform.isMobile = mode !== "desktop";
      Platform.isPhone = mode === "phone";
      const fixture = createFixture();
      const menu = openMenu(kind, fixture);
      try {
        const control = document.querySelector<HTMLElement>(
          ".inkbook-adaptive-panel button, .inkbook-owned-menu-item",
        )!;
        expect(control).not.toBeNull();
        touchDown(control);
        expect(fixture.closed).not.toHaveBeenCalled();
        const outside = touchDown(fixture.canvas);
        expect(outside.defaultPrevented).toBe(true);
        vi.advanceTimersByTime(500);
        expect(fixture.closed).toHaveBeenCalledOnce();
        expect(fixture.start).not.toHaveBeenCalled();
        expect(document.querySelector(".inkbook-adaptive-panel, .inkbook-owned-menu")).toBeNull();
        const next = touchDown(fixture.canvas);
        expect(next.defaultPrevented).toBe(false);
        expect(fixture.start).toHaveBeenCalledOnce();
      } finally {
        menu.close("immediate");
        fixture.boundary.dispose();
      }
    },
  );
});

function createFixture() {
  const root = createDiv();
  root.className = "inkbook-root";
  root.dataset.inkbookMotion = "reduced";
  const anchor = createEl("button");
  const canvas = createDiv();
  root.append(anchor, canvas);
  document.body.append(root);
  const start = vi.fn();
  const boundary = new CanvasTouchBoundary(canvas, {
    onPenPointerCancel: vi.fn(),
    onPenPointerMove: vi.fn(),
    onPenPointerStart: vi.fn(),
    onPenPointerUp: vi.fn(),
    onPrimaryTouchStart: vi.fn(),
    onTouchInterrupted: vi.fn(),
    onTouchPointerMove: vi.fn(),
    onTouchPointerStart: start,
    onTouchTerminal: vi.fn(),
    shouldBlockTouchEvent: () => false,
  });
  return { anchor, canvas, start, boundary, closed: vi.fn() };
}

function openMenu(
  kind: "style" | "background" | "shape" | "overflow" | "context",
  fixture: ReturnType<typeof createFixture>,
) {
  if (kind === "style" || kind === "background") {
    return new AdaptivePanelSession({
      anchor: fixture.anchor,
      canvasInputSurface: fixture.canvas,
      kind,
      label: kind,
      ownerDocument: document,
      ownerWindow: window,
      renderIcon: vi.fn(),
      onClosed: fixture.closed,
      createContent: () => {
        const fragment = createFragment();
        fragment.append(createEl("button"));
        return fragment;
      },
    });
  }
  const menu = createOwnedMenuFactory({
    anchor: kind === "context" ? fixture.canvas : fixture.anchor,
  }).create(kind === "context" ? "context" : "menu");
  menu.addItem((item) => item.setTitle("Action").onClick(vi.fn()));
  menu.onHide(fixture.closed);
  menu.showAtPosition({ x: 50, y: 50 }, document);
  return menu;
}

function touchDown(target: HTMLElement): PointerEvent {
  const event = new PointerEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    pointerType: "touch",
    isPrimary: true,
    pointerId: 1,
  });
  target.dispatchEvent(event);
  return event;
}
