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
import { keymapCaptureFixture } from "../../../fixtures/obsidian/keymap-capture";

const captureKeymap = keymapCaptureFixture();

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
    expect(container.querySelector('button[data-shortcut-action="copy"]')).toBeTruthy();
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
    expect(container.querySelectorAll(".inkbook-shortcut-readonly-row")).toHaveLength(21);
    const fixed = shortcutSection(container, "Fixed system shortcuts");
    for (const name of [
      "Navigate objects",
      "First or last object",
      "Edit geometry",
      "Adjust geometry",
    ]) {
      expect(fixed.textContent).toContain(name);
    }
    expect(fixed.textContent).toContain("Shift uses 10");
    expect(fixed.textContent).toContain("PageUp");
    expect(fixed.textContent).toContain("ArrowRight");
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
    try {
      expand(container, "Canvas shortcuts");
      await vi.runAllTimersAsync();
      const recorder = required<HTMLButtonElement>(
        container,
        'button[data-shortcut-action="copy"]',
      );
      const binding = store.getDeviceSettings().keyboardShortcuts.copy;
      recorder.click();
      expect(document.activeElement).toBe(recorder);
      expect(recorder.getAttribute("aria-pressed")).toBe("true");
      expect(container.querySelector('[data-shortcut-action="copy"]')).toBe(recorder);
      recorder.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(recorder.getAttribute("aria-pressed")).toBe("false");
      expect(recorder.getAttribute("aria-label")).toBe("CtrlC: Change shortcut for Copy selection");
      expect(document.activeElement).toBe(recorder);
      expect(store.getDeviceSettings().keyboardShortcuts.copy).toEqual(binding);
      expectFollowingKeyReleased(recorder);
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
    } finally {
      view.dispose();
    }
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
    expect(
      required(container, 'button[data-shortcut-action="copy"]').getAttribute("aria-label"),
    ).toBe("CtrlK: Change shortcut for Copy selection");

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
    expect(
      required(container, 'button[data-shortcut-action="copy"]').getAttribute("aria-label"),
    ).toBe("Not assigned: Change shortcut for Copy selection");

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

describe("shortcut recording completion", () => {
  it.each([
    ["recording the existing binding", undefined],
    ["resetting the default binding", 'button[aria-label="Reset Copy selection"]'],
    ["resetting the default group", ".inkbook-shortcuts-group-reset"],
    ["clearing an unassigned binding", 'button[aria-label="Clear Copy selection"]'],
  ])("stops capture after %s without a settings change", (operation, selector) => {
    const { container, store, view } = createView();
    try {
      store.updateDeviceSettings((settings) => ({
        ...settings,
        keyboardShortcuts: {
          ...settings.keyboardShortcuts,
          copy:
            operation === "clearing an unassigned binding" ? null : settings.keyboardShortcuts.copy,
        },
      }));
      expand(container, "Canvas shortcuts");
      const recorder = required<HTMLButtonElement>(
        container,
        'button[data-shortcut-action="copy"]',
      );
      const binding = store.getDeviceSettings().keyboardShortcuts.copy;
      const label = recorder.textContent;
      expect(recorder.getAttribute("aria-label")).toBe(
        `${label}: Change shortcut for Copy selection`,
      );
      recorder.click();
      expect(recorder.getAttribute("aria-pressed")).toBe("true");
      expect(recorder.getAttribute("aria-label")).toBe(
        "Press shortcut…: Change shortcut for Copy selection",
      );
      if (selector === undefined) {
        recorder.dispatchEvent(
          new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true }),
        );
      } else click(container, selector);
      expect(container.querySelector('[data-shortcut-action="copy"]')).toBe(recorder);
      expect(recorder.getAttribute("aria-pressed")).toBe("false");
      expect(accessibleText(recorder)).toBe(label);
      expect(recorder.getAttribute("aria-label")).toBe(
        `${label}: Change shortcut for Copy selection`,
      );
      expect(accessibleText(recorder.closest(".inkbook-shortcut-row")!)).not.toContain(
        "Escape to cancel",
      );
      expect(document.activeElement).toBe(
        selector === ".inkbook-shortcuts-group-reset"
          ? container.querySelector(selector)
          : recorder,
      );
      expectFollowingKeyReleased(recorder);
      expect(store.getDeviceSettings().keyboardShortcuts.copy).toEqual(binding);
    } finally {
      view.dispose();
    }
  });
});

function expectFollowingKeyReleased(recorder: HTMLButtonElement): void {
  const event = new KeyboardEvent("keydown", {
    key: "q",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  recorder.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
}

function accessibleText(element: HTMLElement): string | null {
  const clone = element.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return clone.textContent;
}

function createView(hostAccess?: ObsidianHotkeyAccess): {
  readonly container: HTMLElement;
  readonly store: InkbookSettingsStore;
  readonly view: ShortcutSettingsView;
} {
  const store = createTestSettingsStore();
  const container = document.body.createDiv();
  const keymap = captureKeymap(window);
  return {
    container,
    store,
    view: new ShortcutSettingsView(container, store, keymap, hostAccess, () =>
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
    `button[aria-label$="Change shortcut for ${label}"]`,
  );
  recorder.click();
  required<HTMLButtonElement>(
    container,
    `button[aria-label$="Change shortcut for ${label}"]`,
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
