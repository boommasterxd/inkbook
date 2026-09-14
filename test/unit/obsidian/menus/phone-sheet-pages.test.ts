// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { AdaptivePanelSession } from "../../../../src/obsidian/menus/adaptive-panel";
import type { PhoneSheetPage } from "../../../../src/obsidian/menus/panel-page";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

beforeEach(() => {
  installObsidianDomHelpers();
  vi.useFakeTimers();
  Platform.isPhone = true;
  Platform.isMobile = true;
});
afterEach(() => {
  Platform.isPhone = false;
  Platform.isMobile = false;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture(reduced = false, settle = true) {
  const anchor = createEl("button");
  anchor.className = "inkbook-root";
  anchor.dataset.inkbookMotion = reduced ? "reduced" : "full";
  document.body.append(anchor);
  const containerEl = createDiv();
  const modalEl = createEl("section");
  const rootButton = createEl("button");
  rootButton.textContent = "Settings";
  const hostClose = vi.fn();
  let requestClose = (): void => undefined;
  const session = new AdaptivePanelSession({
    anchor,
    canvasInputSurface: anchor,
    ownerDocument: document,
    ownerWindow: window,
    kind: "menu",
    label: "More options",
    onClosed: vi.fn(),
    renderIcon: () => undefined,
    createContent: () => {
      const content = createFragment();
      content.append(rootButton);
      return content;
    },
    phoneHost: {
      containerEl,
      modalEl,
      close: hostClose,
      open: (callback) => {
        requestClose = callback;
        document.body.append(containerEl);
      },
    },
  });
  vi.advanceTimersToNextFrame();
  if (settle) vi.advanceTimersByTime(220);
  const scroll = modalEl.querySelector<HTMLElement>(".inkbook-adaptive-panel-scroll")!;
  let naturalHeight = 300;
  vi.spyOn(scroll, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, 360, Number.parseFloat(scroll.style.blockSize) || naturalHeight),
  );
  Object.defineProperty(scroll, "scrollHeight", { get: () => naturalHeight, configurable: true });
  const dispose = vi.fn();
  const page: PhoneSheetPage = {
    kind: "dialog",
    label: "Inkbook settings",
    dispose,
    createContent: () => {
      const fragment = createFragment();
      const input = createEl("input");
      fragment.append(input);
      naturalHeight = 700;
      return fragment;
    },
  };
  return {
    session,
    modalEl,
    containerEl,
    rootButton,
    scroll,
    page,
    dispose,
    hostClose,
    requestClose: () => requestClose(),
    setHeight: (height: number) => {
      naturalHeight = height;
    },
  };
}

it("retains one host and detaches root actions until native Back restores them", () => {
  const f = fixture();
  f.rootButton.focus();
  f.scroll.scrollTop = 80;
  f.session.navigation?.push(f.page);
  expect(f.rootButton.isConnected).toBe(false);
  expect(document.querySelectorAll(".inkbook-adaptive-panel-layer")).toHaveLength(1);
  expect(f.modalEl.dataset.state).toBe("open");
  expect(f.modalEl.dataset.presence).toBeUndefined();
  expect(f.modalEl.getAttribute("aria-label")).toBe("Inkbook settings");
  expect(f.modalEl.querySelector(".inkbook-phone-dialog-title")).toBeNull();
  expect(f.modalEl.dataset.pageTransition).toBe("forward");
  expect(f.containerEl.dataset.inkbookKeyboardNavigation).toBe("false");
  f.requestClose();
  expect(f.rootButton.isConnected).toBe(true);
  expect(document.activeElement).toBe(f.modalEl);
  expect(f.scroll.scrollTop).toBe(80);
  expect(f.dispose).toHaveBeenCalledOnce();
  expect(f.hostClose).not.toHaveBeenCalled();
  expect(f.modalEl.dataset.pageTransition).toBe("back");
  f.requestClose();
  expect(f.modalEl.dataset.state).toBe("closing");
  vi.advanceTimersByTime(220);
  expect(f.hostClose).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("animates changed height both directions and releases explicit height after 220ms", () => {
  const f = fixture();
  f.session.navigation?.push(f.page);
  expect(f.scroll.style.blockSize).not.toBe("");
  expect(f.modalEl.style.getPropertyValue("--inkbook-phone-page-duration")).toBe("220ms");
  vi.advanceTimersByTime(219);
  expect(f.scroll.style.blockSize).not.toBe("");
  vi.advanceTimersByTime(1);
  expect(f.scroll.style.blockSize).toBe("");
  vi.spyOn(f.scroll, "getBoundingClientRect").mockReturnValueOnce(new DOMRect(0, 0, 360, 460));
  f.setHeight(250);
  f.session.navigation?.back();
  expect(f.scroll.style.blockSize).toBe("250px");
  vi.advanceTimersByTime(220);
  expect(f.scroll.style.blockSize).toBe("");
  f.session.close("immediate");
});

it("Escape returns to root and outside contact disposes the entire sheet during transition", () => {
  const f = fixture();
  f.session.navigation?.push(f.page);
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  expect(f.rootButton.isConnected).toBe(true);
  f.session.navigation?.push(f.page);
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  expect(f.dispose).toHaveBeenCalledTimes(2);
  f.session.navigation?.close("immediate");
  expect(f.hostClose).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("reduces motion to an immediate page swap and cleans replaced pages exactly once", () => {
  const f = fixture(true);
  f.session.navigation?.push(f.page);
  expect(f.modalEl.dataset.pageTransition).toBeUndefined();
  expect(f.scroll.style.blockSize).toBe("");
  f.session.navigation?.push(f.page);
  expect(f.dispose).toHaveBeenCalledOnce();
  f.session.close("immediate");
  expect(f.dispose).toHaveBeenCalledTimes(2);
  f.session.navigation?.push(f.page);
  expect(f.dispose).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("queues a subpage until initial sheet entry finishes and Back can cancel the pending request", () => {
  const f = fixture(false, false);
  f.session.navigation?.push(f.page);
  expect(f.rootButton.isConnected).toBe(true);
  expect(f.modalEl.dataset.pageTransition).toBeUndefined();
  expect(f.session.navigation?.back()).toBe(true);
  expect(f.dispose).toHaveBeenCalledOnce();
  f.session.navigation?.push(f.page);
  vi.advanceTimersByTime(220);
  expect(f.rootButton.isConnected).toBe(false);
  expect(f.modalEl.dataset.presence).toBeUndefined();
  expect(f.modalEl.dataset.pageTransition).toBe("forward");
  f.session.close("immediate");
});

it("freezes the visible height before an animated exit interrupts a page resize", () => {
  const f = fixture();
  f.session.navigation?.push(f.page);
  vi.spyOn(f.scroll, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 360, 380));
  f.session.close();
  expect(f.scroll.style.blockSize).toBe("380px");
  expect(f.modalEl.dataset.pageFrozen).toBe("true");
  expect(f.modalEl.dataset.pageTransition).toBeUndefined();
  vi.advanceTimersByTime(220);
  expect(f.hostClose).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("holds the visible page height under a dragging finger and resumes only after cancellation", () => {
  const f = fixture();
  f.session.navigation?.push(f.page);
  vi.spyOn(f.scroll, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 360, 380));
  const handle = f.modalEl.querySelector<HTMLElement>(".inkbook-adaptive-panel-drag-region")!;
  handle.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      pointerType: "touch",
      pointerId: 7,
      clientY: 300,
    }),
  );
  expect(f.modalEl.dataset.swipeState).toBe("dragging");
  expect(f.scroll.style.blockSize).toBe("380px");
  expect(f.modalEl.dataset.pageTransition).toBeUndefined();
  vi.advanceTimersByTime(1_000);
  expect(f.scroll.style.blockSize).toBe("380px");
  f.modalEl.dispatchEvent(
    new PointerEvent("pointercancel", { bubbles: true, pointerType: "touch", pointerId: 7 }),
  );
  expect(f.scroll.style.blockSize).not.toBe("380px");
  expect(f.modalEl.dataset.pageTransition).toBeUndefined();
  vi.advanceTimersToNextFrame();
  vi.advanceTimersByTime(220);
  expect(f.scroll.style.blockSize).toBe("");
  expect(f.modalEl.dataset.pageFrozen).toBeUndefined();
  f.session.close("immediate");
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves the paused page height when the sheet closes during a drag", () => {
  const f = fixture();
  f.session.navigation?.push(f.page);
  vi.spyOn(f.scroll, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 360, 370));
  const handle = f.modalEl.querySelector<HTMLElement>(".inkbook-adaptive-panel-drag-region")!;
  handle.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 8 }),
  );
  f.session.close();
  expect(f.scroll.style.blockSize).toBe("370px");
  vi.advanceTimersByTime(220);
  expect(f.hostClose).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("restores the root item for keyboard navigation but clears its focus after touch return", () => {
  const f = fixture();
  f.rootButton.focus();
  f.rootButton.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  f.session.navigation?.push(f.page);
  expect(f.containerEl.dataset.inkbookKeyboardNavigation).toBe("true");
  f.requestClose();
  expect(document.activeElement).toBe(f.rootButton);
  f.session.navigation?.push(f.page);
  const back = f.modalEl.querySelector<HTMLButtonElement>(".inkbook-adaptive-panel-back")!;
  back.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true }));
  back.click();
  expect(f.containerEl.dataset.inkbookKeyboardNavigation).toBe("false");
  expect(document.activeElement).toBe(f.modalEl);
  expect(f.rootButton.matches(":focus")).toBe(false);
  f.session.close("immediate");
});

it("does not process Escape twice after the native host has returned to the root", () => {
  const f = fixture();
  f.session.navigation?.push(f.page);
  const escape = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  escape.preventDefault();
  f.requestClose();
  f.modalEl.dispatchEvent(escape);
  expect(f.rootButton.isConnected).toBe(true);
  expect(f.modalEl.dataset.state).toBe("open");
  expect(f.hostClose).not.toHaveBeenCalled();
  f.requestClose();
  vi.advanceTimersByTime(220);
  expect(f.hostClose).toHaveBeenCalledOnce();
});

function resizingBackground() {
  const f = fixture();
  f.session.navigation?.push({ ...f.page, kind: "background" });
  vi.advanceTimersByTime(220);
  f.setHeight(250);
  f.session.prepareLayoutChange();
  f.setHeight(350);
  f.session.requestLayout();
  vi.advanceTimersToNextFrame();
  expect(f.scroll.style.blockSize).toBe("350px");
  return f;
}
it("keeps a newer Back transition alive after replacing a Background content resize", () => {
  const f = resizingBackground();
  vi.advanceTimersByTime(100);
  f.setHeight(300);
  f.session.navigation?.back();
  expect(f.scroll.style.blockSize).toBe("300px");
  vi.advanceTimersByTime(120);
  expect(f.modalEl.dataset.pageTransition).toBe("back");
  expect(f.scroll.style.blockSize).toBe("300px");
  f.session.close("immediate");
});
it("freezes Background content resizing at the visible height during swipe", () => {
  const f = resizingBackground();
  vi.spyOn(f.scroll, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 360, 280));
  const handle = f.modalEl.querySelector<HTMLElement>(".inkbook-adaptive-panel-drag-region")!;
  handle.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 7 }),
  );
  expect(f.modalEl.dataset.swipeState).toBe("dragging");
  expect(f.scroll.style.blockSize).toBe("280px");
  vi.advanceTimersByTime(1000);
  expect(f.scroll.style.blockSize).toBe("280px");
  f.modalEl.dispatchEvent(
    new PointerEvent("pointercancel", { bubbles: true, pointerType: "touch", pointerId: 7 }),
  );
  expect(f.scroll.style.blockSize).toBe("350px");
  vi.advanceTimersByTime(220);
  expect(f.scroll.style.blockSize).toBe("");
  f.session.close("immediate");
});

it("keeps phone content resizing independent of viewport position writes", () => {
  const f = fixture();
  const writes = vi.spyOn(f.containerEl.style, "setProperty");
  f.session.requestLayout();
  vi.advanceTimersToNextFrame();
  expect(writes).not.toHaveBeenCalled();
  window.dispatchEvent(new Event("resize"));
  vi.advanceTimersToNextFrame();
  expect(writes).toHaveBeenCalledWith(
    "--inkbook-adaptive-panel-viewport-height",
    expect.any(String),
  );
  f.session.close("immediate");
});

it("does not schedule frames or read heights for phone dialog content changes", () => {
  const f = fixture();
  f.session.navigation?.push(f.page);
  vi.advanceTimersByTime(240);
  const requestFrame = vi.spyOn(window, "requestAnimationFrame");
  const readHeight = vi.spyOn(f.scroll, "getBoundingClientRect");
  readHeight.mockClear();
  f.session.prepareLayoutChange();
  f.session.requestLayout();
  expect(requestFrame).not.toHaveBeenCalled();
  expect(readHeight).not.toHaveBeenCalled();
  f.session.close("immediate");
});
