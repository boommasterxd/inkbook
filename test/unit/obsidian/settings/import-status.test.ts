// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { MotionPreference } from "../../../../src/rendering/motion/transitions";
import { renderImportStatus } from "../../../../src/obsidian/settings/import/import-status";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

beforeEach(installObsidianDomHelpers);
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function fixture(initial: MotionPreference) {
  const container = document.body.createDiv();
  const query = Object.assign(new EventTarget(), { matches: false });
  const releaseQuery = vi.spyOn(query, "removeEventListener");
  vi.spyOn(window, "matchMedia").mockReturnValue(query as unknown as MediaQueryList);
  const releaseVisibility = vi.spyOn(document, "removeEventListener");
  const listeners = new Set<() => void>();
  const disposals: (() => void)[] = [];
  let preference = initial;
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const operation = renderImportStatus(container, "Scanning vault…", "scan", {
    mutate: (update) => update(),
    readMotion: () => preference,
    observeMotion: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    own: (dispose) => disposals.push(dispose),
  });
  return {
    container,
    operation,
    releaseQuery,
    releaseVisibility,
    listeners,
    animations: () => [...container.querySelectorAll("svg *")].flatMap((el) => el.getAnimations()),
    motion: (value: MotionPreference) => {
      preference = value;
      for (const listener of listeners) listener();
    },
    visibility: (value: boolean) => {
      hidden = value;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    dispose: () => {
      for (const dispose of disposals) dispose();
    },
  };
}

it("bounds full-motion scan work and stops hidden or reduced operations without losing status", () => {
  const scan = fixture("full");
  try {
    expect(scan.animations()).toHaveLength(4);
    expect(scan.container.textContent).toContain("Your files stay unchanged.");
    scan.visibility(true);
    expect(scan.animations()).toHaveLength(0);
    scan.visibility(false);
    expect(scan.animations()).toHaveLength(4);
    scan.motion("reduced");
    expect(scan.animations()).toHaveLength(0);
    expect(scan.container.textContent).toContain("Scanning vault…");
    scan.visibility(true);
    scan.visibility(false);
    expect(scan.animations()).toHaveLength(0);
    scan.motion("full");
    expect(scan.animations()).toHaveLength(4);
    scan.operation.stop();
    expect(scan.animations()).toHaveLength(0);
    expect(scan.container.textContent).toContain("Stopping safely…");
    expect(scan.container.textContent).toContain("Your files are unchanged.");
    scan.motion("reduced");
    scan.motion("full");
    scan.visibility(true);
    scan.visibility(false);
    expect(scan.animations()).toHaveLength(0);
  } finally {
    scan.dispose();
  }
  expect(scan.listeners.size).toBe(0);
  expect(scan.releaseQuery).toHaveBeenCalledWith("change", expect.any(Function));
  expect(scan.releaseVisibility).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
});

it("starts reduced without loops and releases active animations and observers on disposal", () => {
  const scan = fixture("reduced");
  expect(scan.animations()).toHaveLength(0);
  scan.motion("full");
  expect(scan.animations()).toHaveLength(4);
  scan.dispose();
  expect(scan.animations()).toHaveLength(0);
  expect(scan.listeners.size).toBe(0);
  expect(scan.releaseQuery).toHaveBeenCalledWith("change", expect.any(Function));
  expect(scan.releaseVisibility).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  scan.motion("full");
  scan.visibility(true);
  scan.visibility(false);
  expect(scan.animations()).toHaveLength(0);
});
