// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";

import { Window as HappyWindow } from "happy-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { MotionPreference } from "../../../../src/rendering/motion/transitions";
import { InkbookFeedbackManager } from "../../../../src/obsidian/feedback/feedback-manager";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

beforeEach(() => {
  installObsidianDomHelpers();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function preferences(ownerWindow: Window) {
  let preference: MotionPreference = "full";
  const listeners = new Set<() => void>();
  const query = Object.assign(new EventTarget(), { matches: false });
  vi.spyOn(ownerWindow, "matchMedia").mockReturnValue(query as MediaQueryList);
  const manager = new InkbookFeedbackManager({
    readMotion: () => preference,
    observeMotion: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  return {
    manager,
    show: () =>
      manager.showInWindow(ownerWindow, {
        code: "drawing-load-failed",
        actions: [{ id: "dismiss", run: () => false }],
      }),
    query,
    listeners,
    set: (value: MotionPreference) => {
      preference = value;
      for (const listener of listeners) listener();
    },
  };
}

it.each([false, true])("uses initial saved Reduced for global feedback in pop-out %s", (popout) => {
  const ownerWindow = popout ? (new HappyWindow() as unknown as Window) : window;
  const state = preferences(ownerWindow);
  state.set("reduced");
  const handle = state.show();
  expect(ownerWindow.document.querySelector(".inkbook-feedback")).not.toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  handle.close();
  expect(ownerWindow.document.querySelector(".inkbook-feedback")).toBeNull();
  expect(state.listeners.size).toBe(0);
  state.manager.dispose();
});

it("interrupts live global exit, respects Full over System and releases subscriptions", () => {
  const state = preferences(window);
  const restoreAnimations = enableFeedbackAnimations();
  try {
    state.query.matches = true;
    const handle = state.show();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    handle.close();
    const feedback = document.querySelector<HTMLElement>(".inkbook-feedback")!;
    expect(feedback.inert).toBe(true);
    state.set("system");
    expect(feedback.isConnected).toBe(false);
    expect(state.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    state.manager.dispose();
    restoreAnimations();
  }
});

it("settles an already visible global entrance on a live system Reduced event", () => {
  const state = preferences(window);
  state.set("system");
  const restoreAnimations = enableFeedbackAnimations();
  try {
    const removeListener = vi.spyOn(state.query, "removeEventListener");
    const handle = state.show();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    state.query.matches = true;
    state.query.dispatchEvent(new Event("change"));
    const feedback = document.querySelector<HTMLElement>(".inkbook-feedback")!;
    expect(feedback.isConnected).toBe(true);
    expect(feedback.style.scale).toBe("1");
    expect(vi.getTimerCount()).toBe(0);
    handle.close();
    expect(feedback.isConnected).toBe(false);
    expect(removeListener).toHaveBeenCalledWith("change", expect.any(Function));
  } finally {
    state.manager.dispose();
    restoreAnimations();
  }
});

function enableFeedbackAnimations(): () => void {
  const prototype = HTMLElement.prototype;
  const properties = ["animate", "getAnimations"] as const;
  const originals = properties.map((property) =>
    Object.getOwnPropertyDescriptor(prototype, property),
  );
  Object.defineProperties(prototype, {
    animate: { configurable: true, value: vi.fn() },
    getAnimations: { configurable: true, value: () => [] },
  });
  return () => {
    properties.forEach((property, index) => {
      const original = originals[index];
      if (original === undefined) Reflect.deleteProperty(prototype, property);
      else Object.defineProperty(prototype, property, original);
    });
  };
}

it("ends an attached native press before removing feedback and releases every window lease", () => {
  const state = preferences(window);
  state.set("reduced");
  const handle = state.show();
  const button = document.querySelector<HTMLButtonElement>(".inkbook-feedback button")!;
  const add = vi.spyOn(window, "addEventListener");
  const remove = vi.spyOn(window, "removeEventListener");
  const canceled = vi.fn(() => expect(button.isConnected).toBe(true));
  button.addEventListener("pointercancel", canceled);
  button.focus();
  button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(button.style.backgroundColor).toBe("var(--interactive-hover)");
  const leases = add.mock.calls.filter(([name]) => name === "blur" || name === "pagehide");
  handle.close("immediate");
  expect(canceled).toHaveBeenCalledOnce();
  expect(button.isConnected).toBe(false);
  for (const [name, listener] of leases) expect(remove).toHaveBeenCalledWith(name, listener);
  expect(state.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  state.manager.dispose();
});
