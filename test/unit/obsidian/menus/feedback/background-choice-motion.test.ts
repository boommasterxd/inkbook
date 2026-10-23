// @vitest-environment happy-dom
import "../../../../fixtures/obsidian/menu-motion";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { registerBackgroundChoiceMotion } from "../../../../../src/obsidian/menus/feedback/background-choice-motion";
import { createBackgroundMenuContent } from "../../../../../src/obsidian/menus/background-menu-content";
import type { BackgroundMenuState } from "../../../../../src/obsidian/menus/editor-menu-types";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";

const releases: (() => void)[] = [];
beforeEach(() => {
  installObsidianDomHelpers();
  vi.useFakeTimers();
});
afterEach(() => {
  for (const release of releases.splice(0)) release();
  document.body.replaceChildren();
  vi.useRealTimers();
});

function fixture() {
  let state: BackgroundMenuState = { type: "none", spacing: null };
  const root = document.body.createDiv({ cls: "inkbook-root" });
  root.dataset.inkbookMotion = "full";
  const render = () =>
    createBackgroundMenuContent({
      getState: () => state,
      initialState: state,
      onSpacingChange: () => undefined,
      onSpacingPreview: () => undefined,
      onTypeChange: (type) => {
        state = { type, spacing: type === "none" ? null : "m" };
      },
      ownerDocument: document,
      renderIcon: () => undefined,
    });
  root.append(render());
  const motion = registerBackgroundChoiceMotion(root, root, window);
  releases.push(motion.dispose);
  const button = (type: string) =>
    root.querySelector<HTMLButtonElement>(`[data-background-type='${type}']`)!;
  const check = (type: string) =>
    button(type).querySelector<HTMLElement>(".inkbook-menu-background-choice-check")!;
  return { root, motion, button, check, render };
}

it("commits selection immediately and retargets checkmarks without losing button focus", async () => {
  const f = fixture();
  const lines = f.button("lines");
  lines.focus();

  lines.click();

  expect(lines.getAttribute("aria-pressed")).toBe("true");
  expect(f.button("none").getAttribute("aria-pressed")).toBe("false");
  expect(f.check("none").hidden).toBe(false);
  await vi.advanceTimersByTimeAsync(30);
  expect(f.check("lines").hidden).toBe(false);
  f.button("none").click();
  await vi.advanceTimersByTimeAsync(120);
  expect(f.check("none").hidden).toBe(false);
  expect(f.check("lines").hidden).toBe(true);
  expect(f.button("lines")).toBe(lines);
  expect(document.activeElement).toBe(lines);
  expect(f.check("none").getAttribute("aria-hidden")).toBe("true");
});

it("finishes reduced feedback and releases replaced controls and pending animations", async () => {
  const f = fixture();
  f.button("lines").click();
  await vi.advanceTimersByTimeAsync(1);

  f.root.dataset.inkbookMotion = "reduced";
  f.motion.finish();

  expect(f.check("none").hidden).toBe(true);
  expect(f.check("lines").hidden).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  f.root.dataset.inkbookMotion = "full";
  f.button("none").click();
  await vi.advanceTimersByTimeAsync(1);
  const removed = f.button("none");
  f.root.replaceChildren(f.render());
  await vi.advanceTimersByTimeAsync(0);
  expect(removed.isConnected).toBe(false);
  expect(removed.querySelector("[data-inkbook-motion-check]")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  f.button("dots").click();
  await vi.advanceTimersByTimeAsync(1);
  f.motion.dispose();
  expect(f.check("dots").hidden).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
