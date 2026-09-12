// @vitest-environment happy-dom

import { type App, Platform } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOwnedMenuFactory } from "../../../../src/obsidian/menus/owned-menu-factory";
import { createPhoneSheetHost } from "../../../../src/obsidian/menus/phone-sheet-host";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { nativeModalStack, simulateNativeModalBack } from "../../../adapters/obsidian/settings";

beforeEach(() => {
  installObsidianDomHelpers();
  vi.useFakeTimers();
  Platform.isPhone = false;
  Platform.isMobile = false;
});
afterEach(() => {
  document.body.replaceChildren();
  Platform.isPhone = false;
  Platform.isMobile = false;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture(kind: "context" | "menu" = "menu") {
  const anchor = createEl("button");
  anchor.className = "inkbook-root";
  anchor.dataset.inkbookMotion = "full";
  document.body.append(anchor);
  const keymap = { pushScope: vi.fn(), popScope: vi.fn() };
  const app = { workspace: { containerEl: document.body } } as App;
  const factory = createOwnedMenuFactory({
    anchor,
    keymap,
    createPhoneSheetHost: () => createPhoneSheetHost(app),
  });
  const menu = factory.create(kind);
  const onHide = vi.fn();
  const action = vi.fn();
  menu.onHide(onHide);
  menu.addItem((item) => item.setTitle("Run").onClick(action));
  return { anchor, keymap, factory, menu, onHide, action };
}

function surface(): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    ".inkbook-owned-menu, .inkbook-adaptive-panel",
  );
  if (element === null) throw new Error("Menu was not mounted");
  return element;
}

function show(test: ReturnType<typeof fixture>): HTMLElement {
  test.menu.showAtPosition({ x: 40, y: 60 }, document);
  return surface();
}

function expectReleased(test: ReturnType<typeof fixture>, element: HTMLElement): void {
  expect(element.isConnected).toBe(false);
  expect(test.onHide).toHaveBeenCalledOnce();
  expect(test.keymap.popScope).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
}

describe("owned wide menus", () => {
  it.each([false, true])("opens once with 120ms motion on tablet=%s", (tablet) => {
    Platform.isMobile = tablet;
    const test = fixture();
    const element = show(test);
    expect(element.style.getPropertyValue("--inkbook-owned-menu-duration")).toBe("120ms");
    expect(element.dataset.mobile).toBe(String(tablet));
    expect(element.style.insetInlineStart).toBe("42px");
    expect(element.style.insetBlockStart).toBe("62px");
    expect(element.contains(document.activeElement)).toBe(true);
    show(test);
    expect(document.querySelectorAll(".inkbook-owned-menu")).toHaveLength(1);
    expect(test.keymap.pushScope).toHaveBeenCalledOnce();
    test.menu.close();
    expect(element.dataset.state).toBe("closing");
    vi.advanceTimersByTime(120);
    expect(element.isConnected).toBe(false);
    expect(test.keymap.popScope).toHaveBeenCalledExactlyOnceWith(
      test.keymap.pushScope.mock.calls[0]?.[0],
    );
    expect(test.onHide).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts interrupted entrance exit from the visible scale and opacity once", () => {
    const test = fixture();
    const element = show(test);
    const computed = window.createDiv().style;
    computed.scale = "0.975";
    computed.opacity = "0.4";
    const reads = vi.spyOn(window, "getComputedStyle").mockReturnValue(computed);
    test.menu.close();
    expect(element.style.getPropertyValue("--inkbook-wide-menu-exit-scale")).toBe("0.975");
    expect(element.style.getPropertyValue("--inkbook-wide-menu-exit-opacity")).toBe("0.4");
    expect(element.inert).toBe(true);
    vi.advanceTimersByTime(60);
    test.menu.close();
    expect(reads).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(59);
    expect(element.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(element.isConnected).toBe(false);
    expect(test.onHide).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disables motion for a reduced-motion anchor", () => {
    const test = fixture();
    test.anchor.dataset.inkbookMotion = "reduced";
    expect(show(test).style.getPropertyValue("--inkbook-owned-menu-duration")).toBe("0ms");
    test.menu.close();
  });
});

describe("owned wide menu close lifecycle", () => {
  it.each(["Escape", "Tab", "outside", "resize", "blur", "scroll", "pagehide"])(
    "closes on %s once and releases its listeners",
    (reason) => {
      const test = fixture();
      const element = show(test);
      const close = () => {
        if (reason === "Escape" || reason === "Tab")
          document.dispatchEvent(new KeyboardEvent("keydown", { key: reason, bubbles: true }));
        else if (reason === "outside")
          document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        else if (reason === "scroll") document.dispatchEvent(new Event("scroll"));
        else window.dispatchEvent(new Event(reason));
      };
      close();
      if (reason !== "pagehide") expect(element.dataset.state).toBe("closing");
      close();
      test.menu.close("immediate");
      expectReleased(test, element);
    },
  );

  it("keeps the menu open for internal pointer and scrolling, then closes after the action callback", () => {
    const test = fixture();
    const element = show(test);
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(test.onHide).not.toHaveBeenCalled();
    test.action.mockImplementation(() => expect(element.isConnected).toBe(true));
    element.querySelector<HTMLElement>('[role="menuitem"]')?.click();
    expect(test.action).toHaveBeenCalledOnce();
    expect(test.onHide).toHaveBeenCalledOnce();
  });

  it("routes keyboard navigation from the initial content focus to an action", () => {
    const test = fixture();
    const element = show(test);
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(test.action).toHaveBeenCalledOnce();
    expect(element.isConnected).toBe(false);
  });

  it("deduplicates an event, allows callers to finish its items, and cancels a pending show", () => {
    const test = fixture();
    const event = new MouseEvent("contextmenu", { cancelable: true, clientX: 12, clientY: 24 });
    const menu = test.factory.forEvent(event);
    expect(test.factory.forEvent(event)).toBe(menu);
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector(".inkbook-owned-menu")).toBeNull();
    menu.addItem((item) => item.setTitle("Deferred"));
    vi.runOnlyPendingTimers();
    expect(surface().textContent).toBe("Deferred");
    menu.close("immediate");
    const canceled = test.factory.forEvent(new MouseEvent("contextmenu"));
    const hidden = vi.fn();
    canceled.onHide(hidden);
    canceled.close("immediate");
    vi.runAllTimers();
    expect(document.querySelector(".inkbook-owned-menu")).toBeNull();
    expect(hidden).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    test.menu.close();
  });
});

describe("owned menu unavailable document and reentrant cleanup", () => {
  it("does not leave scheduled work for a document without a window", () => {
    const test = fixture();
    const detached = document.implementation.createHTMLDocument();
    test.menu.showAtPosition({ x: 0, y: 0 }, detached);
    expect(detached.querySelector(".inkbook-owned-menu")).toBeNull();
    const target = detached.body;
    target.addEventListener("contextmenu", (event) =>
      test.factory.forEvent(event).close("immediate"),
    );
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    test.menu.close("immediate");
    expect(test.onHide).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows the hide callback to force cleanup again without duplicate callbacks", () => {
    const test = fixture();
    test.menu.onHide(() => test.menu.close("immediate"));
    const element = show(test);
    test.menu.close();
    vi.advanceTimersByTime(60);
    test.menu.close("immediate");
    vi.runAllTimers();
    expectReleased(test, element);
  });
});

describe("owned phone menus", () => {
  it.each(["context", "menu"] as const)("keeps native Back and 220ms exit for %s", (kind) => {
    Platform.isPhone = true;
    Platform.isMobile = true;
    const test = fixture(kind);
    const element = show(test);
    expect(element.style.getPropertyValue("--inkbook-adaptive-panel-entry-duration")).toBe(
      kind === "context" ? "120ms" : "220ms",
    );
    expect(element.style.getPropertyValue("--inkbook-adaptive-panel-duration")).toBe("220ms");
    expect(nativeModalStack(document)).toHaveLength(1);
    expect(test.keymap.pushScope).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
    simulateNativeModalBack(document);
    expect(element.dataset.state).toBe("closing");
    vi.advanceTimersByTime(219);
    expect(test.onHide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(test.onHide).toHaveBeenCalledOnce();
    expect(element.isConnected).toBe(false);
    expect(nativeModalStack(document)).toHaveLength(0);
    test.menu.close("immediate");
    expect(test.onHide).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["immediate", "handoff"] as const)(
    "disposes an entering phone menu synchronously for %s",
    (mode) => {
      Platform.isPhone = true;
      Platform.isMobile = true;
      const test = fixture();
      const element = show(test);
      test.menu.close(mode);
      expect(element.isConnected).toBe(false);
      expect(nativeModalStack(document)).toHaveLength(0);
      expect(test.onHide).toHaveBeenCalledOnce();
      vi.runAllTimers();
      expect(document.querySelector(".inkbook-adaptive-panel")).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("navigates from initial phone focus and prevents repeated action activation", () => {
    Platform.isPhone = true;
    Platform.isMobile = true;
    const test = fixture();
    show(test);
    vi.advanceTimersToNextFrame();
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    const row = document.activeElement as HTMLElement;
    expect(row.getAttribute("role")).toBe("menuitem");
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    row.click();
    expect(test.action).toHaveBeenCalledOnce();
    expect(test.onHide).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not activate a row after native Back has started closing", () => {
    Platform.isPhone = true;
    Platform.isMobile = true;
    const test = fixture();
    const element = show(test);
    vi.advanceTimersToNextFrame();
    simulateNativeModalBack(document);
    element.querySelector<HTMLElement>('[role="menuitem"]')?.click();
    expect(test.action).not.toHaveBeenCalled();
    vi.advanceTimersByTime(220);
    expect(test.onHide).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases native history before a queued action opens another dialog", async () => {
    Platform.isPhone = true;
    Platform.isMobile = true;
    const test = fixture();
    const element = show(test);
    const queued = vi.fn(() => expect(nativeModalStack(document)).toHaveLength(0));
    test.action.mockImplementation(() => window.queueMicrotask(queued));
    element.querySelector<HTMLElement>('[role="menuitem"]')?.click();
    expect(test.action).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(queued).toHaveBeenCalledOnce();
    expect(test.onHide).toHaveBeenCalledOnce();
    expect(element.isConnected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
