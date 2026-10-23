// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";
import { MotionGlobalConfig } from "motion";
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ShortcutSettingsView } from "../../../../src/obsidian/settings/shortcuts/shortcut-view";
import type { ObsidianHotkeyAccess } from "../../../../src/obsidian/settings/shortcuts/obsidian-hotkey-conflicts";
import type { InkbookSettingsStore } from "../../../../src/obsidian/settings/storage";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { createTestSettingsStore } from "../../../fixtures/obsidian/settings-store";

beforeEach(() => {
  installObsidianDomHelpers();
  document.body.replaceChildren();
  MotionGlobalConfig.useManualTiming = true;
});

afterEach(() => {
  MotionGlobalConfig.useManualTiming = false;
  vi.useRealTimers();
});

describe("shortcut settings view", () => {
  it("renders accessible shortcut sections collapsed by default", () => {
    const { container, view } = createView(
      hostHotkeys({
        "inkbook:copy-embed": [{ key: "E", modifiers: ["Mod", "Shift"] }],
      }),
    );

    const triggers = container.querySelectorAll<HTMLButtonElement>(
      ".inkbook-shortcut-section-trigger",
    );
    expect(triggers).toHaveLength(4);
    expect(
      [...triggers].every((trigger) => trigger.getAttribute("aria-expanded") === "false"),
    ).toBe(true);
    expect(
      [...container.querySelectorAll<HTMLElement>(".inkbook-shortcut-section")].every(
        (section) => required<HTMLElement>(section, ".inkbook-settings-tool-panel").hidden,
      ),
    ).toBe(true);
    expect(container.querySelectorAll(".inkbook-shortcut-row")).toHaveLength(10);
    expect(
      container.querySelector('button[aria-label="Change shortcut for Copy selection"]'),
    ).toBeTruthy();
    expect(container.textContent).toContain("Fixed system shortcuts");
    expect(container.textContent).toContain("Obsidian commands");
    expect(container.textContent).toContain("Paste a validated clipboard selection");
    const groupReset = required<HTMLElement>(container, ".inkbook-shortcuts-group-reset");
    expect(groupReset.closest(".inkbook-settings-tool-panel")).toBeNull();
    expect(groupReset.classList).toContain("mod-action");
    expect(groupReset.getAttribute("role")).toBe("button");
    expect(groupReset.dataset.inkbookSettingActionTone).toBe("caution");
    expect(groupReset.querySelector(".setting-item-name")?.textContent).toBe(
      "Reset group to defaults",
    );
    expect(groupReset).toBe(container.lastElementChild);
    for (const row of container.querySelectorAll<HTMLElement>(".inkbook-shortcut-row")) {
      expect(row.classList).toContain("setting-item");
      expect(row.querySelector(":scope > .setting-item-info > .setting-item-name")).toBeTruthy();
      expect(
        row.querySelector(":scope > .setting-item-info > .setting-item-description"),
      ).toBeTruthy();
      expect(row.querySelector(":scope > .setting-item-control")).toBeTruthy();
    }
    for (const row of container.querySelectorAll<HTMLElement>(".inkbook-shortcut-reference-row")) {
      expect(row.classList).toContain("setting-item");
      expect(row.querySelector(":scope > .setting-item-info > .setting-item-name")).toBeTruthy();
    }

    for (const row of container.querySelectorAll<HTMLElement>(".inkbook-shortcut-readonly-row")) {
      expect(row.querySelectorAll(".inkbook-shortcut-recorder-static")).toHaveLength(1);
      expect(row.querySelectorAll(".inkbook-shortcut-icon-button")).toHaveLength(0);
      expect(row.querySelector(".inkbook-shortcut-readonly-actions")).toBeNull();
    }
    expect(container.querySelectorAll(".inkbook-shortcut-readonly-row")).toHaveLength(17);
    const gestures = shortcutSection(container, "Pointer and gesture modifiers");
    expect(gestures.querySelectorAll(".inkbook-shortcut-readonly-row")).toHaveLength(7);
    expect(gestures.querySelectorAll(".inkbook-shortcut-recorder-static")).toHaveLength(7);
    expect(gestures.textContent).toContain("CtrlClick");
    expect(gestures.textContent).toContain("ShiftWheel");
    const commands = shortcutSection(container, "Obsidian commands");
    expect(commands.querySelectorAll(".inkbook-shortcut-readonly-row")).toHaveLength(5);
    expect(commands.textContent).toContain("CtrlShiftE");
    expect(commands.querySelectorAll(".inkbook-shortcut-unassigned")).toHaveLength(4);
    expect(commands.textContent).toContain("Not assigned");
    expect(commands.textContent).not.toContain("ObsidianObsidian");
    expect(container.textContent).not.toContain("Context Menu");
    expect(container.textContent).toContain("ShiftF10");

    view.dispose();
  });
});

describe("shortcut recording ownership", () => {
  it("keeps recording focus and bindings through cancellation and releases active feedback", async () => {
    vi.useFakeTimers();
    const { container, store, view } = createView();
    expand(container, "Canvas shortcuts");
    await vi.runAllTimersAsync();
    const recorder = required<HTMLButtonElement>(
      container,
      'button[aria-label="Change shortcut for Copy selection"]',
    );
    const binding = store.getDeviceSettings().keyboardShortcuts.copy;
    const row = recorder.closest<HTMLElement>(".inkbook-shortcut-row")!;
    const followingRow = row.nextElementSibling as HTMLElement;
    const recorderMeasurement = vi.spyOn(recorder, "getBoundingClientRect");
    const followingMeasurement = vi.spyOn(followingRow, "getBoundingClientRect");
    recorder.click();
    expect(recorderMeasurement).toHaveBeenCalled();
    expect(followingMeasurement).toHaveBeenCalled();
    expect(document.activeElement).toBe(recorder);
    expect(recorder.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[data-shortcut-action="copy"]')).toBe(recorder);
    recorder.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(recorder.getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe(recorder);
    expect(store.getDeviceSettings().keyboardShortcuts.copy).toEqual(binding);
    recorder.click();
    store.updateDeviceSettings((settings) => ({ ...settings, motion: "reduced" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(recorder.getAttribute("aria-pressed")).toBe("true");
    expect(vi.getTimerCount()).toBe(0);
    const clear = required<HTMLButtonElement>(
      container,
      'button[aria-label="Clear Copy selection"]',
    );
    clear.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerType: "touch",
        isPrimary: true,
        pointerId: 4,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointercancel", { pointerType: "touch", isPrimary: true, pointerId: 4 }),
    );
    expect(store.getDeviceSettings().keyboardShortcuts.copy).toEqual(binding);
    view.dispose();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "q", ctrlKey: true }));
    expect(store.getDeviceSettings().keyboardShortcuts.copy).toEqual(binding);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

describe("shortcut settings editing", () => {
  it("records, rejects conflicts, clears, and resets a binding", () => {
    const findConflict = vi.fn((binding: { readonly key: string }) =>
      binding.key === "p" ? "app:open-command-palette" : undefined,
    );
    const { container, store, view } = createView(hostHotkeys({}, findConflict));
    expand(container, "Canvas shortcuts");
    record(container, "Copy selection", "k", { ctrlKey: true });
    expect(store.getDeviceSettings().keyboardShortcuts.copy).toEqual({
      key: "k",
      modifiers: ["mod"],
    });

    record(container, "Copy selection", "p", { ctrlKey: true });
    expect(container.textContent).toContain(
      "Already assigned to Obsidian command “app:open-command-palette”.",
    );
    expect(container.querySelector(".inkbook-shortcut-status.is-error")).toBeTruthy();
    expect(store.getDeviceSettings().keyboardShortcuts.copy).toEqual({
      key: "k",
      modifiers: ["mod"],
    });

    record(container, "Copy selection", "a", { ctrlKey: true });
    expect(container.textContent).toContain("Already assigned to Select all.");
    expect(store.getDeviceSettings().keyboardShortcuts.copy).toEqual({
      key: "k",
      modifiers: ["mod"],
    });

    click(container, 'button[aria-label="Clear Copy selection"]');
    expect(store.getDeviceSettings().keyboardShortcuts.copy).toBeNull();
    expect(container.textContent).toContain("Not assigned");

    click(container, 'button[aria-label="Reset Copy selection"]');
    expect(store.getDeviceSettings().keyboardShortcuts.copy).toEqual({
      key: "c",
      modifiers: ["mod"],
    });

    record(container, "Copy selection", "k", { ctrlKey: true });
    click(container, ".inkbook-shortcuts-group-reset");
    expect(store.getDeviceSettings().keyboardShortcuts.copy).toEqual({
      key: "c",
      modifiers: ["mod"],
    });
    view.dispose();
  });

  it("rejects a group reset that would introduce an Obsidian conflict", () => {
    const { container, store, view } = createView(
      hostHotkeys({}, (binding) => (binding.key === "c" ? "editor:conflicting-copy" : undefined)),
    );
    expand(container, "Canvas shortcuts");
    record(container, "Copy selection", "k", { ctrlKey: true });

    click(container, ".inkbook-shortcuts-group-reset");

    expect(store.getDeviceSettings().keyboardShortcuts.copy).toEqual({
      key: "k",
      modifiers: ["mod"],
    });
    expect(container.textContent).toContain(
      "Cannot reset Copy selection: already assigned to Obsidian command “editor:conflicting-copy”.",
    );
    expect(
      required(container, ".inkbook-shortcuts-group-reset .inkbook-shortcut-status.is-error"),
    ).toBeTruthy();
    view.dispose();
  });
});

function createView(hostAccess?: ObsidianHotkeyAccess): {
  readonly container: HTMLElement;
  readonly store: InkbookSettingsStore;
  readonly view: ShortcutSettingsView;
} {
  const store = createTestSettingsStore();
  const container = document.body.createDiv();
  return {
    container,
    store,
    view: new ShortcutSettingsView(container, store, hostAccess, () =>
      workSchedulerFromFrames(window),
    ),
  };
}

function hostHotkeys(
  bindings: Readonly<
    Record<string, readonly { readonly key: string; readonly modifiers: string[] }[]>
  >,
  findConflict: ObsidianHotkeyAccess["findConflict"] = () => undefined,
): ObsidianHotkeyAccess {
  return {
    findConflict,
    readBindings: () => new Map(Object.entries(bindings)),
  };
}

function shortcutSection(container: HTMLElement, label: string): HTMLElement {
  const trigger = required<HTMLButtonElement>(container, ".inkbook-shortcut-section-trigger", {
    text: label,
  });
  return trigger.closest<HTMLElement>(".inkbook-shortcut-section") ?? trigger;
}

function expand(container: HTMLElement, label: string): void {
  required<HTMLButtonElement>(
    container,
    `.inkbook-shortcut-section-trigger[aria-expanded="false"]`,
    {
      text: label,
    },
  ).click();
}

function record(
  container: HTMLElement,
  label: string,
  key: string,
  options: KeyboardEventInit,
): void {
  const recorder = required<HTMLButtonElement>(
    container,
    `button[aria-label="Change shortcut for ${label}"]`,
  );
  recorder.click();
  required<HTMLButtonElement>(
    container,
    `button[aria-label="Change shortcut for ${label}"]`,
  ).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key, ...options }));
}

function click(container: HTMLElement, selector: string): void {
  required<HTMLElement>(container, selector).click();
}

function required<T extends Element>(
  container: ParentNode,
  selector: string,
  options?: { readonly text: string },
): T {
  const element = [...container.querySelectorAll<T>(selector)].find(
    (candidate) => options === undefined || candidate.textContent?.includes(options.text) === true,
  );
  if (element === null) throw new Error(`Missing ${selector}.`);
  if (element === undefined) throw new Error(`Missing ${selector}.`);
  return element;
}
