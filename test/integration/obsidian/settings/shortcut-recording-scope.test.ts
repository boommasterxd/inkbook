// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ShortcutSettingsView } from "../../../../src/obsidian/settings/shortcuts/shortcut-view";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { Keymap, Scope } from "../../../adapters/obsidian/keymap";
import { createTestSettingsStore } from "../../../fixtures/obsidian/settings-store";
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";

const cleanups: Array<() => void> = [];

beforeEach(installObsidianDomHelpers);
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  document.body.replaceChildren();
});

it("cancels recording before the host handles Escape and releases the next Escape", () => {
  const { container, store, view, keymap, hostScope, close } = createView();
  const original = store.getDeviceSettings().keyboardShortcuts.copy;
  const recorder = startRecording(container, "copy");

  recorder.dispatchEvent(key("Escape"));

  expect(close).not.toHaveBeenCalled();
  expect(container.isConnected).toBe(true);
  expect(recorder.getAttribute("aria-pressed")).toBe("false");
  expect(document.activeElement).toBe(recorder);
  expect(store.getDeviceSettings().keyboardShortcuts.copy).toEqual(original);
  expect(keymap.scopes).toEqual([hostScope]);

  recorder.dispatchEvent(key("Escape"));
  expect(close).toHaveBeenCalledOnce();
  expect(container.isConnected).toBe(false);
  view.dispose();
});

it("captures a chord once without executing the earlier host command", () => {
  const hostCommand = vi.fn();
  const { container, store, keymap, hostScope } = createView(hostCommand);
  const changed = vi.fn();
  cleanups.push(store.subscribeDeviceSettings(changed));
  const recorder = startRecording(container, "copy");
  recorder.dispatchEvent(key("p", { ctrlKey: true }));
  expect(hostCommand).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Already assigned to Obsidian command");
  expect(recorder.getAttribute("aria-pressed")).toBe("true");
  const event = key("k", { ctrlKey: true, shiftKey: true });

  recorder.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(true);
  expect(hostCommand).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledOnce();
  expect(store.getDeviceSettings().keyboardShortcuts.copy).toEqual({
    key: "k",
    modifiers: ["mod", "shift"],
  });
  expect(keymap.scopes).toEqual([hostScope]);
  container
    .querySelector<HTMLButtonElement>('[data-shortcut-action="copy"]')
    ?.dispatchEvent(key("p", { ctrlKey: true }));
  expect(hostCommand).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledOnce();
});

it("keeps one capture scope through replacement and releases it on render and disposal", () => {
  const { container, store, view, keymap, hostScope } = createView();
  startRecording(container, "copy");
  expect(keymap.scopes).toHaveLength(2);
  startRecording(container, "cut");
  expect(keymap.scopes).toHaveLength(2);
  expect(container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);

  store.updateDeviceSettings((settings) => ({
    ...settings,
    keyboardShortcuts: { ...settings.keyboardShortcuts, copy: null },
  }));
  expect(keymap.scopes).toEqual([hostScope]);
  expect(container.querySelector('[aria-pressed="true"]')).toBeNull();

  container.querySelector<HTMLButtonElement>('[aria-expanded="false"]')?.click();
  startRecording(container, "copy");
  expect(keymap.scopes).toHaveLength(2);
  view.dispose();
  view.dispose();
  expect(keymap.scopes).toEqual([hostScope]);
  expect(store.getDeviceSettings().keyboardShortcuts.copy).toBeNull();
});

function createView(hostCommand = vi.fn()) {
  const keymap = new Keymap();
  const hostScope = new Scope();
  const container = document.body.createDiv();
  const close = vi.fn(() => container.remove());
  hostScope.register([], "Escape", (event) => {
    if (!event.defaultPrevented) close();
    return false;
  });
  hostScope.register(null, "p", () => {
    hostCommand();
    return false;
  });
  keymap.pushScope(hostScope);
  // The native host installs this listener before plugin recording can begin.
  cleanups.push(keymap.installCapture(window));
  const store = createTestSettingsStore();
  const view = new ShortcutSettingsView(
    container,
    store,
    keymap,
    {
      findConflict: (binding) => (binding.key === "p" ? "app:command-palette" : undefined),
      readBindings: () => new Map(),
    },
    () => workSchedulerFromFrames(window),
  );
  cleanups.push(() => view.dispose());
  container.querySelector<HTMLButtonElement>(".inkbook-shortcut-section-trigger")?.click();
  return { container, store, view, keymap, hostScope, close };
}

function startRecording(container: HTMLElement, action: string): HTMLButtonElement {
  const recorder = container.querySelector<HTMLButtonElement>(`[data-shortcut-action="${action}"]`);
  if (recorder === null) throw new Error(`Missing ${action} recorder.`);
  recorder.click();
  expect(recorder.getAttribute("aria-pressed")).toBe("true");
  expect(document.activeElement).toBe(recorder);
  return recorder;
}

function key(value: string, options: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options });
}
