import { setIcon } from "obsidian";
import { registerNativeControlFeedback } from "../../menus/feedback/native-control-feedback";
import { ShortcutRecordingMotion } from "./shortcut-recording-motion";

import {
  CONFIGURABLE_SHORTCUT_ACTIONS,
  createBuiltInKeyboardShortcuts,
  shortcutConflict,
  type ConfigurableShortcutActionV1,
  type KeyboardShortcutBindingV1,
} from "../../../domain/settings/index";
import { captureShortcutBinding } from "../../../editor/input/index";
import type { ObsidianHotkeyAccess } from "./obsidian-hotkey-conflicts";
import { bindSettingsAction, createSettingsRow } from "../settings-row";
import { CONFIGURABLE_SHORTCUT_REFERENCE } from "./shortcut-catalog";
import { renderShortcutBinding } from "./shortcut-key-display";
import type { InkbookSettingsStore } from "../storage";

export class ShortcutRecordingView {
  readonly #container: HTMLElement;
  readonly #hostHotkeys: ObsidianHotkeyAccess;
  readonly #motion: ShortcutRecordingMotion;
  readonly #recorders = new Map<
    ConfigurableShortcutActionV1,
    { button: HTMLButtonElement; status: HTMLElement }
  >();
  readonly #store: InkbookSettingsStore;
  #recordingAction: ConfigurableShortcutActionV1 | undefined;
  #recordingCleanup: (() => void) | undefined;
  #hoverCleanup: Array<() => void> = [];

  public constructor(
    container: HTMLElement,
    store: InkbookSettingsStore,
    hostHotkeys: ObsidianHotkeyAccess,
  ) {
    this.#container = container;
    this.#store = store;
    this.#hostHotkeys = hostHotkeys;
    this.#motion = new ShortcutRecordingMotion(container, () => store.getDeviceSettings().motion);
  }

  public prepareRender(): void {
    this.#removeRecordingCapture();
    for (const cleanup of this.#hoverCleanup) cleanup();
    this.#hoverCleanup = [];
    this.#recorders.clear();
    this.#motion.finish();
  }

  public dispose(): void {
    this.prepareRender();
    this.#motion.dispose();
  }

  public renderActions(container: HTMLElement): void {
    for (const action of CONFIGURABLE_SHORTCUT_ACTIONS) this.#renderAction(container, action);
  }

  public renderGroupResetAction(container: HTMLElement): void {
    const { info, row: reset } = createSettingsRow(container, {
      className: "inkbook-shortcuts-group-reset",
      description: "Restore the built-in bindings without changing existing files or elements.",
      name: "Reset group to defaults",
    });
    const status = info.createDiv({ cls: "inkbook-shortcut-status" });
    status.setAttribute("aria-live", "polite");
    this.#hoverCleanup.push(bindSettingsAction(reset, () => this.#resetGroup(status), "caution"));
    this.#bindFeedback(reset);
  }

  #renderAction(container: HTMLElement, action: ConfigurableShortcutActionV1): void {
    const binding = this.#store.getDeviceSettings().keyboardShortcuts[action];
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
    recorder.setAttribute("aria-pressed", "false");
    renderShortcutBinding(recorder, binding);
    this.#labelRecorder(recorder, action, recorder);
    this.#recorders.set(action, { button: recorder, status });
    recorder.addEventListener("click", () => {
      this.#startRecording(action);
    });
    controls.append(
      iconButton(row.ownerDocument, "rotate-ccw", `Reset ${reference.label}`, () =>
        this.#reset(action, status),
      ),
      iconButton(row.ownerDocument, "x", `Clear ${reference.label}`, () => this.#clear(action)),
    );
    this.#bindFeedback(row);
  }

  #bindFeedback(root: HTMLElement): void {
    this.#hoverCleanup.push(
      registerNativeControlFeedback(root, {
        readMotion: () => this.#store.getDeviceSettings().motion,
        observeMotion: (listener) =>
          this.#store.subscribeDeviceSettings(() => {
            listener();
            this.#motion.finishReduced();
          }),
      }),
    );
  }

  #startRecording(action: ConfigurableShortcutActionV1): void {
    this.#stopRecording();
    const entry = this.#recorders.get(action);
    if (entry === undefined) return;
    this.#recordingAction = action;
    entry.button.dataset.recording = "true";
    entry.button.setAttribute("aria-pressed", "true");
    this.#motion.replace(entry.button, (content) => {
      content.textContent = "Press shortcut…";
      this.#labelRecorder(entry.button, action, content);
    });
    this.#showStatus(entry.status, "Press a shortcut, or Escape to cancel.", false);
    this.#installRecordingCapture(action, entry.status);
    entry.button.focus({ preventScroll: true });
  }

  #stopRecording(): void {
    const action = this.#recordingAction;
    this.#recordingAction = undefined;
    this.#removeRecordingCapture();
    if (action === undefined) return;
    const entry = this.#recorders.get(action);
    if (entry === undefined) return;
    entry.button.dataset.recording = "false";
    entry.button.setAttribute("aria-pressed", "false");
    this.#motion.replace(entry.button, (content) => {
      renderShortcutBinding(content, this.#store.getDeviceSettings().keyboardShortcuts[action]);
      this.#labelRecorder(entry.button, action, content);
    });
    this.#showStatus(entry.status, "", false);
  }

  #labelRecorder(
    button: HTMLButtonElement,
    action: ConfigurableShortcutActionV1,
    content: HTMLElement,
  ): void {
    button.setAttribute(
      "aria-label",
      `${content.textContent ?? ""}: Change shortcut for ${CONFIGURABLE_SHORTCUT_REFERENCE[action].label}`,
    );
  }

  #showStatus(status: HTMLElement, message: string, error: boolean): void {
    this.#motion.replace(status, (content) => {
      status.classList.toggle("is-error", error);
      content.textContent = message;
    });
  }

  #capture(event: KeyboardEvent, action: ConfigurableShortcutActionV1, status: HTMLElement): void {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === "Escape") {
      this.#stopRecording();
      this.#focusRecorder(action);
      return;
    }
    const capture = captureShortcutBinding(event);
    if (capture.kind === "ignored") return;
    if (capture.kind === "reserved") {
      this.#showStatus(status, "That key is reserved for system or accessibility behavior.", true);
      return;
    }
    const conflict = this.#conflict(action, capture.binding);
    if (conflict !== undefined) {
      this.#showStatus(
        status,
        `Already assigned to ${CONFIGURABLE_SHORTCUT_REFERENCE[conflict].label}.`,
        true,
      );
      return;
    }
    if (this.#showHostConflict(capture.binding, status)) return;
    this.#stopRecording();
    this.#store.updateDeviceSettings((settings) => ({
      ...settings,
      keyboardShortcuts: { ...settings.keyboardShortcuts, [action]: capture.binding },
    }));
    this.#focusRecorder(action);
  }

  #reset(action: ConfigurableShortcutActionV1, status: HTMLElement): void {
    const binding = createBuiltInKeyboardShortcuts()[action];
    const conflict = binding === null ? undefined : this.#conflict(action, binding);
    if (conflict !== undefined) {
      this.#showStatus(
        status,
        `The default is already assigned to ${CONFIGURABLE_SHORTCUT_REFERENCE[conflict].label}.`,
        true,
      );
      return;
    }
    if (binding !== null && this.#showHostConflict(binding, status)) return;
    this.#stopRecording();
    this.#store.updateDeviceSettings((settings) => ({
      ...settings,
      keyboardShortcuts: { ...settings.keyboardShortcuts, [action]: binding },
    }));
    this.#focusRecorder(action);
  }

  #clear(action: ConfigurableShortcutActionV1): void {
    this.#stopRecording();
    this.#store.updateDeviceSettings((settings) => ({
      ...settings,
      keyboardShortcuts: { ...settings.keyboardShortcuts, [action]: null },
    }));
    this.#focusRecorder(action);
  }

  #resetGroup(status: HTMLElement): void {
    const defaults = createBuiltInKeyboardShortcuts();
    const conflict = this.#defaultHostConflict(defaults);
    if (conflict !== undefined) {
      this.#showStatus(
        status,
        `Cannot reset ${CONFIGURABLE_SHORTCUT_REFERENCE[conflict.action].label}: already assigned to Obsidian command “${conflict.commandId}”.`,
        true,
      );
      return;
    }
    this.#stopRecording();
    this.#store.updateDeviceSettings((settings) => ({
      ...settings,
      keyboardShortcuts: defaults,
    }));
    this.#container.querySelector<HTMLElement>(".inkbook-shortcuts-group-reset")?.focus();
  }

  #conflict(
    action: ConfigurableShortcutActionV1,
    binding: KeyboardShortcutBindingV1,
  ): ConfigurableShortcutActionV1 | undefined {
    return shortcutConflict(this.#store.getDeviceSettings().keyboardShortcuts, action, binding);
  }

  #showHostConflict(binding: KeyboardShortcutBindingV1, status: HTMLElement): boolean {
    const conflict = this.#hostHotkeys.findConflict(binding);
    if (conflict === undefined) return false;
    this.#showStatus(status, `Already assigned to Obsidian command “${conflict}”.`, true);
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

  #focusRecorder(action: ConfigurableShortcutActionV1): void {
    this.#container
      .querySelector<HTMLButtonElement>(`[data-shortcut-action="${action}"]`)
      ?.focus({ preventScroll: true });
  }
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
