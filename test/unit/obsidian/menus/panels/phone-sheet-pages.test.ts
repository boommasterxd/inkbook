// @vitest-environment happy-dom
import "../../../../fixtures/obsidian/menu-motion";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { AdaptivePanelSession } from "../../../../../src/obsidian/menus/panels/adaptive-panel";
import type { PhoneSheetPage } from "../../../../../src/obsidian/menus/panels/panel-page";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";

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
    workScheduler: workSchedulerFromFrames(window),
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

function cancelOwnedSwipe(f: ReturnType<typeof fixture>, pointerId: number): void {
  vi.advanceTimersByTime(1_000);
  expect(f.modalEl.dataset.swipeState).toBe("dragging");
  f.modalEl.dispatchEvent(
    new PointerEvent("pointercancel", { bubbles: true, pointerType: "touch", pointerId }),
  );
  expect(f.scroll.style.blockSize).toBe("");
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

it("commits page changes in both directions and completes page motion after 220ms", () => {
  const f = fixture();
  f.session.navigation?.push(f.page);
  expect(f.rootButton.isConnected).toBe(false);
  expect(f.scroll.style.blockSize).toBe("");
  expect(f.modalEl.dataset.pageTransition).toBe("forward");
  vi.advanceTimersByTime(219);
  expect(f.modalEl.dataset.pageTransition).toBe("forward");
  vi.advanceTimersByTime(1);
  expect(f.modalEl.dataset.pageTransition).toBeUndefined();
  f.session.navigation?.back();
  expect(f.rootButton.isConnected).toBe(true);
  expect(f.modalEl.dataset.pageTransition).toBe("back");
  vi.advanceTimersByTime(220);
  expect(f.modalEl.dataset.pageTransition).toBeUndefined();
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

it("ends an already running page transition when the motion preference becomes reduced", async () => {
  const f = fixture();
  try {
    f.session.navigation?.push(f.page);
    const input = f.scroll.querySelector("input")!;
    input.focus();
    expect(f.modalEl.dataset.pageTransition).toBe("forward");
    const root = document.querySelector<HTMLElement>(".inkbook-root")!;

    root.dataset.inkbookMotion = "reduced";
    await vi.advanceTimersByTimeAsync(1);

    expect(f.modalEl.dataset.pageTransition).toBeUndefined();
    expect((f.scroll.firstElementChild as HTMLElement).style.translate).toBe("");
    expect((f.scroll.firstElementChild as HTMLElement).style.opacity).toBe("");
    expect(document.activeElement).toBe(input);
    expect(input.isConnected).toBe(true);
  } finally {
    f.session.close("immediate");
  }
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

it("clears page motion when an animated exit interrupts navigation", () => {
  const f = fixture();
  f.session.navigation?.push(f.page);
  vi.spyOn(f.scroll, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 360, 380));
  f.session.close();
  expect(f.scroll.style.blockSize).toBe("");
  expect(f.modalEl.dataset.pageTransition).toBeUndefined();
  vi.advanceTimersByTime(220);
  expect(f.hostClose).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("stops page entrance feedback while a swipe is owned and resets after cancellation", () => {
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
  expect(f.scroll.style.blockSize).toBe("");
  expect(f.modalEl.dataset.pageTransition).toBeUndefined();
  cancelOwnedSwipe(f, 7);
  expect(f.modalEl.dataset.pageTransition).toBeUndefined();
  vi.advanceTimersToNextFrame();
  vi.advanceTimersByTime(220);
  expect(f.scroll.style.blockSize).toBe("");
  expect(f.modalEl.dataset.swipeState).toBeUndefined();
  f.session.close("immediate");
  expect(vi.getTimerCount()).toBe(0);
});

it("closes during a drag without a pinned scroll height", () => {
  const f = fixture();
  f.session.navigation?.push(f.page);
  vi.spyOn(f.scroll, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 360, 370));
  const handle = f.modalEl.querySelector<HTMLElement>(".inkbook-adaptive-panel-drag-region")!;
  handle.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 8 }),
  );
  f.session.close();
  expect(f.scroll.style.blockSize).toBe("");
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
  f.session.mutateLayout(() => f.setHeight(350));
  expect(f.scroll.style.blockSize).toBe("");
  return f;
}
it("keeps a newer Back transition alive after replacing a Background content resize", () => {
  const f = resizingBackground();
  vi.advanceTimersByTime(100);
  f.setHeight(300);
  f.session.navigation?.back();
  expect(f.scroll.style.blockSize).toBe("");
  vi.advanceTimersByTime(120);
  expect(f.modalEl.dataset.pageTransition).toBe("back");
  expect(f.scroll.style.blockSize).toBe("");
  f.session.close("immediate");
});
it("keeps Background content mounted while a swipe cancels page feedback", () => {
  const f = resizingBackground();
  vi.spyOn(f.scroll, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 360, 280));
  const handle = f.modalEl.querySelector<HTMLElement>(".inkbook-adaptive-panel-drag-region")!;
  handle.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 7 }),
  );
  expect(f.modalEl.dataset.swipeState).toBe("dragging");
  expect(f.scroll.style.blockSize).toBe("");
  cancelOwnedSwipe(f, 7);
  vi.advanceTimersByTime(220);
  expect(f.scroll.style.blockSize).toBe("");
  f.session.close("immediate");
});

it("keeps phone content resizing independent of viewport position writes", () => {
  const f = fixture();
  const writes = vi.spyOn(f.containerEl.style, "setProperty");
  f.session.mutateLayout(() => undefined);
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
  f.session.mutateLayout(() => undefined);
  expect(requestFrame).not.toHaveBeenCalled();
  expect(readHeight).not.toHaveBeenCalled();
  f.session.close("immediate");
});
