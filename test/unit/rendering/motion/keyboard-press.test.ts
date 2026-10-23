// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

import { registerOwnedMotionPress } from "../../../../src/rendering/motion/keyboard-press";

let release: (() => void) | undefined;
afterEach(() => {
  release?.();
  release = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("releases detached native press listeners and its callback exactly once on disposal", () => {
  const button = document.createElementNS("http://www.w3.org/1999/xhtml", "button");
  document.body.append(button);
  const add = vi.spyOn(window, "addEventListener");
  const remove = vi.spyOn(window, "removeEventListener");
  const end = vi.fn();
  const start = vi.fn(() => end);
  release = registerOwnedMotionPress([button], start);
  button.focus();
  button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(start).toHaveBeenCalledOnce();
  const leases = add.mock.calls.filter(([name]) => name === "blur" || name === "pagehide");
  expect(leases).toHaveLength(2);
  button.remove();
  release();
  release();
  expect(end).toHaveBeenCalledOnce();
  for (const [name, listener] of leases) {
    expect(remove).toHaveBeenCalledWith(name, listener);
  }
  window.dispatchEvent(new Event("blur"));
  window.dispatchEvent(new Event("pagehide"));
  expect(end).toHaveBeenCalledOnce();
});
