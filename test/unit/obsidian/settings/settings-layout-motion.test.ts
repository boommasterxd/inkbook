// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushSync } from "react-dom";

import { createSettingsLayoutMotion } from "../../../../src/obsidian/settings/settings-layout-motion";
import { createSettingsValidationMotion } from "../../../../src/obsidian/settings/settings-validation-motion";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

beforeEach(() => {
  installObsidianDomHelpers();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each([
  { preference: "reduced" as const, systemReduced: false, measured: false },
  { preference: "full" as const, systemReduced: true, measured: true },
])(
  "honors $preference device motion over the system preference",
  ({ preference, systemReduced, measured }) => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: systemReduced } as MediaQueryList);
    const group = document.body.createDiv({ cls: "inkbook-settings-page-group" });
    const row = group.createDiv({ cls: "inkbook-settings-background-row setting-item" });
    const heading = row.createDiv({ cls: "inkbook-settings-visual-info" });
    const content = row.createDiv();
    const choices = content.createDiv({ cls: "inkbook-menu-background-choices" });
    const spacing = content.createDiv({ cls: "inkbook-menu-background-spacing" });
    const following = group.createDiv({ cls: "setting-item" });
    const rowReads = vi.spyOn(row, "getBoundingClientRect");
    const followingReads = vi.spyOn(following, "getBoundingClientRect");
    const contentReads = [heading, choices, spacing].map((element) =>
      vi.spyOn(element, "getBoundingClientRect"),
    );
    const layout = createSettingsLayoutMotion(content, () => preference);
    layout.mutate(() => {
      spacing.createEl("input", { cls: "inkbook-menu-spacing-slider" });
    });
    expect(spacing.querySelector("input")).not.toBeNull();
    expect(rowReads.mock.calls.length > 0).toBe(measured);
    expect(followingReads.mock.calls.length > 0).toBe(measured);
    for (const reads of contentReads) expect(reads.mock.calls.length > 0).toBe(measured);
    expect(content.parentElement).toBe(row);
    expect(following.parentElement).toBe(group);
    expect(spacing.parentElement).toBe(content);
    layout.mutate(() => spacing.replaceChildren());
    expect(spacing.childElementCount).toBe(0);
    layout.dispose();
  },
);

it("ignores a queued layout update after disposal", () => {
  const content = document.body.createDiv();
  const layout = createSettingsLayoutMotion(content, () => "full");
  const update = vi.fn();
  layout.dispose();
  expect(() => layout.mutate(update)).not.toThrow();
  expect(update).not.toHaveBeenCalled();
});

it("retargets running layout to Reduced without replacing the focused native control", () => {
  let preference: "full" | "reduced" = "full";
  let changed: () => void = () => undefined;
  const unsubscribe = vi.fn();
  const group = document.body.createDiv({ cls: "inkbook-settings-page-group" });
  const row = group.createDiv({ cls: "setting-item" });
  const content = row.createDiv();
  const input = content.createEl("input");
  const error = row.createDiv();
  error.id = "native-layout-error";
  error.setAttribute("aria-live", "polite");
  const observeMotion = vi.fn((listener: () => void) => {
    changed = listener;
    return unsubscribe;
  });
  const validation = createSettingsValidationMotion(content, {
    readMotion: () => preference,
    observeMotion,
  });
  const layout = createSettingsLayoutMotion(content, () => preference, observeMotion);
  group.scrollTop = 40;
  input.focus();
  validation.set(error, "The setting could not be saved.");
  layout.mutate(() => {
    content.createEl("button");
  });
  preference = "reduced";
  changed();
  expect(content.style.transform).toBe("");
  expect(content.querySelector("input")).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(group.scrollTop).toBe(40);
  expect(error.hidden).toBe(false);
  expect(error.getAttribute("aria-live")).toBe("polite");
  expect(observeMotion).toHaveBeenCalledOnce();
  layout.dispose();
  expect(unsubscribe).not.toHaveBeenCalled();
  validation.dispose();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("starts error feedback before a frame and retains native presence through reversal and completion", () => {
  const group = document.body.createDiv();
  const row = group.createDiv({ cls: "setting-item" });
  const error = row.createDiv();
  error.id = "native-presence-error";
  const validation = createSettingsValidationMotion(row, { readMotion: () => "full" });
  validation.set(error, "Saving failed");
  const visual = group.querySelector<HTMLElement>(".inkbook-settings-validation-visual")!;
  const entrance = visual.getAnimations();
  // No frame or microtask has run: native feedback must already be admitted.
  expect(entrance).toHaveLength(1);
  expect(visual.style.opacity).toBe("1");
  flushSync(() => entrance[0]!.finish());
  expect(visual.style.opacity).toBe("1");
  validation.set(error, "");
  expect(error.hidden).toBe(true);
  const exit = visual.getAnimations()[0]!;
  expect(exit).toBeDefined();
  validation.set(error, "Saving failed");
  expect(exit.playState).toBe("idle");
  expect(visual.isConnected).toBe(true);
  flushSync(() => visual.getAnimations()[0]!.finish());
  validation.set(error, "");
  flushSync(() => visual.getAnimations()[0]!.finish());
  expect(group.querySelector(".inkbook-settings-validation-visual")).toBeNull();
  validation.dispose();
});

it("cancels native error feedback when reduced motion settles or its owner is disposed", () => {
  let preference: "full" | "reduced" = "full";
  let changed = (): void => undefined;
  const group = document.body.createDiv();
  const row = group.createDiv({ cls: "setting-item" });
  const error = row.createDiv();
  error.id = "native-disposal-error";
  const validation = createSettingsValidationMotion(row, {
    readMotion: () => preference,
    observeMotion: (listener) => {
      changed = listener;
      return () => undefined;
    },
  });
  validation.set(error, "Saving failed");
  const visual = group.querySelector<HTMLElement>(".inkbook-settings-validation-visual")!;
  const entrance = visual.getAnimations()[0]!;
  preference = "reduced";
  changed();
  expect(entrance.playState).toBe("idle");
  expect(group.querySelector(".inkbook-settings-validation-visual")?.textContent).toBe(
    "Saving failed",
  );
  preference = "full";
  changed();
  validation.set(error, "Saving still failed");
  const replacement = group.querySelector<HTMLElement>(".inkbook-settings-validation-visual")!;
  const replacementEntrance = replacement.getAnimations()[0]!;
  validation.dispose();
  expect(replacementEntrance.playState).toBe("idle");
  expect(group.querySelector(".inkbook-settings-validation-visual")).toBeNull();
});
