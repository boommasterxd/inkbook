import { Platform, setIcon } from "obsidian";

import {
  CONFIGURABLE_SHORTCUT_ACTIONS,
  createBuiltInKeyboardShortcuts,
  shortcutConflict,
  type ConfigurableShortcutActionV1,
  type KeyboardShortcutBindingV1,
} from "../../domain/settings/index";
import { captureShortcutBinding } from "../../editor/input/index";
import type { InkbookSettingsStore } from "./storage";
import type { ObsidianHotkeyAccess, ObsidianHotkeyBinding } from "./obsidian-hotkey-conflicts";
import { createSettingsDisclosure } from "./settings-disclosure";
import { SettingsPanelMotion } from "./settings-panel-motion";
import { bindSettingsAction, createSettingsRow } from "./settings-row";
import {
  CONFIGURABLE_SHORTCUT_REFERENCE,
  FIXED_SHORTCUT_REFERENCE,
  GESTURE_MODIFIER_REFERENCE,
  OBSIDIAN_COMMAND_REFERENCE,
  type FixedShortcutReferenceEntry,
} from "./shortcut-catalog";

type ShortcutSectionId = "canvas" | "commands" | "fixed" | "gestures";

let shortcutViewSequence = 0;

export class ShortcutSettingsView {
  readonly #container: HTMLElement;
  readonly #expandedSections = new Set<ShortcutSectionId>();
  readonly #idPrefix = `inkbook-shortcuts-${String(++shortcutViewSequence)}`;
  #panelMotions: SettingsPanelMotion[] = [];
  readonly #store: InkbookSettingsStore;
  readonly #hostHotkeys: ObsidianHotkeyAccess;
  readonly #unsubscribe: () => void;
  #disposed = false;
  #recordingAction: ConfigurableShortcutActionV1 | undefined;
  #recordingCleanup: (() => void) | undefined;

  public constructor(
    container: HTMLElement,
    store: InkbookSettingsStore,
    hostHotkeys: ObsidianHotkeyAccess = EMPTY_OBSIDIAN_HOTKEY_ACCESS,
  ) {
    this.#container = container;
    this.#store = store;
    this.#hostHotkeys = hostHotkeys;
    this.#unsubscribe = store.subscribeDeviceSettings(() => this.render());
    this.render();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.#removeRecordingCapture();
    this.#disposePanelMotions();
    this.#container.replaceChildren();
  }

  public render(): void {
    if (this.#disposed) return;
    this.#removeRecordingCapture();
    this.#disposePanelMotions();
    this.#container.replaceChildren();
    this.#container.classList.add("inkbook-shortcuts-view");
    const canvas = this.#renderSection(
      "canvas",
      "Canvas shortcuts",
      "Configure device-local bindings used while an Inkbook canvas is active.",
    );
    canvas.classList.add("inkbook-shortcut-section-content-canvas");
    const list = canvas.createDiv({ cls: "inkbook-shortcuts-list" });
    for (const action of CONFIGURABLE_SHORTCUT_ACTIONS) this.#renderAction(list, action);
    this.#renderFixedSection();
    this.#renderGestureSection();
    this.#renderCommandSection();
    this.#renderGroupResetAction();
  }

  #renderGroupResetAction(): void {
    const { info, row: reset } = createSettingsRow(this.#container, {
      className: "inkbook-shortcuts-group-reset",
      description: "Restore the built-in bindings without changing existing files or elements.",
      name: "Reset group to defaults",
    });
    const status = info.createDiv({ cls: "inkbook-shortcut-status" });
    status.setAttribute("aria-live", "polite");
    const activate = (): void => {
      const defaults = createBuiltInKeyboardShortcuts();
      const conflict = this.#defaultHostConflict(defaults);
      if (conflict !== undefined) {
        showStatus(
          status,
          `Cannot reset ${CONFIGURABLE_SHORTCUT_REFERENCE[conflict.action].label}: already assigned to Obsidian command “${conflict.commandId}”.`,
          true,
        );
        return;
      }
      this.#recordingAction = undefined;
      this.#store.updateDeviceSettings((settings) => ({
        ...settings,
        keyboardShortcuts: defaults,
      }));
      this.#container.querySelector<HTMLElement>(".inkbook-shortcuts-group-reset")?.focus();
    };
    bindSettingsAction(reset, activate, "caution");
  }

  #renderSection(id: ShortcutSectionId, name: string, description: string): HTMLElement {
    const panelId = `${this.#idPrefix}-${id}`;
    const expanded = this.#expandedSections.has(id);
    const { content, panel, trigger } = createSettingsDisclosure(this.#container, {
      contentClass: "inkbook-shortcut-section-content",
      description,
      expanded,
      panelId,
      sectionClass: "inkbook-shortcut-section",
      title: name,
      triggerClass: "inkbook-shortcut-section-trigger",
    });
    const motion = new SettingsPanelMotion(panel, () => this.#store.getDeviceSettings().motion);
    this.#panelMotions.push(motion);
    trigger.addEventListener("click", () => {
      const nextExpanded = trigger.getAttribute("aria-expanded") !== "true";
      trigger.setAttribute("aria-expanded", String(nextExpanded));
      if (nextExpanded) this.#expandedSections.add(id);
      else this.#expandedSections.delete(id);
      motion.setExpanded(nextExpanded);
    });
    return content;
  }

  #renderAction(container: HTMLElement, action: ConfigurableShortcutActionV1): void {
    const settings = this.#store.getDeviceSettings();
    const binding = settings.keyboardShortcuts[action];
    const reference = CONFIGURABLE_SHORTCUT_REFERENCE[action];
    const {
      control: controls,
      info,
      row,
    } = createSettingsRow(container, {
      className: "inkbook-shortcut-row",
      description: reference.description,
      name: reference.label,
    });
    controls.classList.add("inkbook-shortcut-controls");
    const status = info.createDiv({ cls: "inkbook-shortcut-status" });
    status.setAttribute("aria-live", "polite");
    const recorder = controls.createEl("button", { cls: "inkbook-shortcut-recorder" });
    recorder.type = "button";
    recorder.dataset.shortcutAction = action;
    recorder.setAttribute("aria-label", `Change shortcut for ${reference.label}`);
    recorder.setAttribute("aria-pressed", "false");
    renderBinding(recorder, binding);
    if (this.#recordingAction === action) {
      beginRecording(recorder, status);
      this.#installRecordingCapture(action, status);
    }
    recorder.addEventListener("click", () => {
      this.#recordingAction = action;
      this.render();
      this.#focusRecorder(action);
    });
    controls.append(
      iconButton(row.ownerDocument, "rotate-ccw", `Reset ${reference.label}`, () =>
        this.#reset(action, status),
      ),
      iconButton(row.ownerDocument, "x", `Clear ${reference.label}`, () => this.#clear(action)),
    );
  }

  #capture(event: KeyboardEvent, action: ConfigurableShortcutActionV1, status: HTMLElement): void {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === "Escape") {
      this.#recordingAction = undefined;
      this.render();
      this.#focusRecorder(action);
      return;
    }
    const capture = captureShortcutBinding(event);
    if (capture.kind === "ignored") return;
    if (capture.kind === "reserved") {
      showStatus(status, "That key is reserved for system or accessibility behavior.", true);
      return;
    }
    const conflict = this.#conflict(action, capture.binding);
    if (conflict !== undefined) {
      const conflictingName = CONFIGURABLE_SHORTCUT_REFERENCE[conflict].label;
      showStatus(status, `Already assigned to ${conflictingName}.`, true);
      return;
    }
    if (this.#showHostConflict(capture.binding, status)) return;
    this.#recordingAction = undefined;
    this.#store.updateDeviceSettings((settings) => ({
      ...settings,
      keyboardShortcuts: { ...settings.keyboardShortcuts, [action]: capture.binding },
    }));
    this.#focusRecorder(action);
  }

  #reset(action: ConfigurableShortcutActionV1, status: HTMLElement): void {
    const defaults = createBuiltInKeyboardShortcuts();
    const binding = defaults[action];
    const conflict = binding === null ? undefined : this.#conflict(action, binding);
    if (conflict !== undefined) {
      showStatus(
        status,
        `The default is already assigned to ${CONFIGURABLE_SHORTCUT_REFERENCE[conflict].label}.`,
        true,
      );
      return;
    }
    if (binding !== null && this.#showHostConflict(binding, status)) return;
    this.#recordingAction = undefined;
    this.#store.updateDeviceSettings((settings) => ({
      ...settings,
      keyboardShortcuts: { ...settings.keyboardShortcuts, [action]: binding },
    }));
    this.#focusRecorder(action);
  }

  #clear(action: ConfigurableShortcutActionV1): void {
    this.#recordingAction = undefined;
    this.#store.updateDeviceSettings((settings) => ({
      ...settings,
      keyboardShortcuts: { ...settings.keyboardShortcuts, [action]: null },
    }));
    this.#focusRecorder(action);
  }

  #conflict(
    action: ConfigurableShortcutActionV1,
    binding: KeyboardShortcutBindingV1,
  ): ConfigurableShortcutActionV1 | undefined {
    return shortcutConflict(this.#store.getDeviceSettings().keyboardShortcuts, action, binding);
  }

  #focusRecorder(action: ConfigurableShortcutActionV1): void {
    this.#container
      .querySelector<HTMLButtonElement>(`[data-shortcut-action="${action}"]`)
      ?.focus({ preventScroll: true });
  }

  #showHostConflict(binding: KeyboardShortcutBindingV1, status: HTMLElement): boolean {
    const conflict = this.#hostHotkeys.findConflict(binding);
    if (conflict === undefined) return false;
    showStatus(status, `Already assigned to Obsidian command “${conflict}”.`, true);
    return true;
  }

  #defaultHostConflict(
    defaults: ReturnType<typeof createBuiltInKeyboardShortcuts>,
  ): { readonly action: ConfigurableShortcutActionV1; readonly commandId: string } | undefined {
    for (const action of CONFIGURABLE_SHORTCUT_ACTIONS) {
      const binding = defaults[action];
      if (binding === null) continue;
      const commandId = this.#hostHotkeys.findConflict(binding);
      if (commandId !== undefined) return { action, commandId };
    }
    return undefined;
  }

  #installRecordingCapture(action: ConfigurableShortcutActionV1, status: HTMLElement): void {
    const ownerWindow = this.#container.ownerDocument.defaultView;
    if (ownerWindow === null) return;
    const listener = (event: KeyboardEvent): void => this.#capture(event, action, status);
    ownerWindow.addEventListener("keydown", listener, { capture: true });
    this.#recordingCleanup = () =>
      ownerWindow.removeEventListener("keydown", listener, { capture: true });
  }

  #removeRecordingCapture(): void {
    this.#recordingCleanup?.();
    this.#recordingCleanup = undefined;
  }

  #renderGestureSection(): void {
    const content = this.#renderSection(
      "gestures",
      "Pointer and gesture modifiers",
      "Review modifier keys that temporarily change canvas gestures.",
    );
    content.classList.add("inkbook-shortcut-section-content-reference");
    const list = content.createDiv({ cls: "inkbook-shortcut-reference-list" });
    for (const entry of GESTURE_MODIFIER_REFERENCE) {
      this.#renderReadOnlyShortcut(list, entry, "Gesture modifier");
    }
  }

  #renderFixedSection(): void {
    const content = this.#renderSection(
      "fixed",
      "Fixed system shortcuts",
      "Review protected editing and accessibility bindings that remain consistent.",
    );
    content.classList.add("inkbook-shortcut-section-content-reference");
    const list = content.createDiv({ cls: "inkbook-shortcut-reference-list" });
    for (const entry of FIXED_SHORTCUT_REFERENCE) {
      this.#renderReadOnlyShortcut(list, entry, "Fixed shortcut");
    }
  }

  #renderReadOnlyShortcut(
    container: HTMLElement,
    entry: FixedShortcutReferenceEntry,
    ariaPrefix: string,
  ): void {
    const { control, row } = createSettingsRow(container, {
      className: "inkbook-shortcut-reference-row",
      description: entry.description,
      name: entry.label,
    });
    row.classList.add("inkbook-shortcut-readonly-row");
    control.classList.add("inkbook-shortcut-controls");
    const display = control.createDiv({
      cls: "inkbook-shortcut-recorder inkbook-shortcut-recorder-static",
    });
    renderReadOnlyBinding(display, entry.keyGroups);
    display.setAttribute("aria-label", `${ariaPrefix} for ${entry.label}: ${display.textContent}`);
  }

  #renderCommandSection(): void {
    const content = this.#renderSection(
      "commands",
      "Obsidian commands",
      "Assign these plugin commands from Obsidian's Hotkeys settings.",
    );
    content.classList.add("inkbook-shortcut-section-content-reference");
    const list = content.createDiv({ cls: "inkbook-shortcut-reference-list" });
    const bindings = this.#hostHotkeys.readBindings();
    for (const command of OBSIDIAN_COMMAND_REFERENCE) {
      const keyGroups = (bindings.get(command.commandId) ?? []).map(obsidianHotkeyParts);
      this.#renderReadOnlyShortcut(list, { ...command, keyGroups }, "Obsidian shortcut");
    }
  }

  #disposePanelMotions(): void {
    for (const motion of this.#panelMotions) motion.dispose();
    this.#panelMotions = [];
  }
}

const EMPTY_OBSIDIAN_HOTKEY_ACCESS: ObsidianHotkeyAccess = {
  findConflict: () => undefined,
  readBindings: () => new Map(),
};

function beginRecording(button: HTMLButtonElement, status: HTMLElement): void {
  button.dataset.recording = "true";
  button.setAttribute("aria-pressed", "true");
  button.replaceChildren(button.ownerDocument.createTextNode("Press shortcut…"));
  showStatus(status, "Press a shortcut, or Escape to cancel.", false);
}

function renderBinding(container: HTMLElement, binding: KeyboardShortcutBindingV1 | null): void {
  container.replaceChildren();
  if (binding === null) {
    container.createSpan({ cls: "inkbook-shortcut-unassigned", text: "Not assigned" });
    return;
  }
  renderKeyGroups(container, [bindingParts(binding)]);
}

function renderKeyGroups(container: HTMLElement, groups: readonly (readonly string[])[]): void {
  groups.forEach((group, groupIndex) => {
    if (groupIndex > 0) container.createSpan({ cls: "inkbook-shortcut-alternative", text: "or" });
    for (const part of group) container.createEl("kbd", { text: fixedKeyLabel(part) });
  });
}

function renderReadOnlyBinding(
  container: HTMLElement,
  groups: readonly (readonly string[])[],
): void {
  if (groups.length === 0) {
    container.createSpan({ cls: "inkbook-shortcut-unassigned", text: "Not assigned" });
    return;
  }
  renderKeyGroups(container, groups);
}

function obsidianHotkeyParts(binding: ObsidianHotkeyBinding): readonly string[] {
  return [...binding.modifiers, binding.key];
}

function fixedKeyLabel(part: string): string {
  return part === "Mod" ? (Platform.isMacOS ? "⌘" : "Ctrl") : part;
}

function bindingParts(binding: KeyboardShortcutBindingV1): readonly string[] {
  const modifiers = binding.modifiers.map((modifier) => {
    if (modifier === "mod") return Platform.isMacOS ? "⌘" : "Ctrl";
    if (modifier === "meta") return "Meta";
    return modifier[0]?.toUpperCase() + modifier.slice(1);
  });
  return [...modifiers, keyLabel(binding.key)];
}

function keyLabel(key: string): string {
  if (key === "ArrowUp") return "↑";
  if (key === "ArrowDown") return "↓";
  if (key === "ArrowLeft") return "←";
  if (key === "ArrowRight") return "→";
  if (key === " ") return "Space";
  return key.length === 1 ? key.toUpperCase() : key;
}

function iconButton(
  ownerDocument: Document,
  icon: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const ownerWindow = ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error("Shortcut controls require an owning window.");
  const button = ownerWindow.createEl("button");
  button.type = "button";
  button.className = "clickable-icon inkbook-shortcut-icon-button";
  button.setAttribute("aria-label", label);
  button.setAttribute("data-tooltip-position", "top");
  setIcon(button, icon);
  button.addEventListener("click", onClick);
  return button;
}

function showStatus(status: HTMLElement, message: string, error: boolean): void {
  status.textContent = message;
  status.classList.toggle("is-error", error);
}
