import type { InkbookSettingsStore } from "./storage";
import type { ObsidianHotkeyAccess } from "./obsidian-hotkey-conflicts";
import { ShortcutRecordingView } from "./shortcut-recording-view";
import { ShortcutReferenceView } from "./shortcut-reference-view";
import { createSettingsDisclosure } from "./settings-disclosure";
import { SettingsPanelMotion } from "./settings-panel-motion";

type ShortcutSectionId = "canvas" | "commands" | "fixed" | "gestures";

let shortcutViewSequence = 0;

export class ShortcutSettingsView {
  readonly #container: HTMLElement;
  readonly #expandedSections = new Set<ShortcutSectionId>();
  readonly #idPrefix = `inkbook-shortcuts-${String(++shortcutViewSequence)}`;
  readonly #recordingView: ShortcutRecordingView;
  readonly #referenceView: ShortcutReferenceView;
  readonly #store: InkbookSettingsStore;
  readonly #unsubscribe: () => void;
  #disposed = false;
  #panelMotions: SettingsPanelMotion[] = [];

  public constructor(
    container: HTMLElement,
    store: InkbookSettingsStore,
    hostHotkeys: ObsidianHotkeyAccess = EMPTY_OBSIDIAN_HOTKEY_ACCESS,
  ) {
    this.#container = container;
    this.#store = store;
    this.#recordingView = new ShortcutRecordingView(container, store, hostHotkeys, () =>
      this.render(),
    );
    this.#referenceView = new ShortcutReferenceView(hostHotkeys);
    this.#unsubscribe = store.subscribeDeviceSettings(() => this.render());
    this.render();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.#recordingView.dispose();
    this.#disposePanelMotions();
    this.#container.replaceChildren();
  }

  public render(): void {
    if (this.#disposed) return;
    this.#recordingView.prepareRender();
    this.#disposePanelMotions();
    this.#container.replaceChildren();
    this.#container.classList.add("inkbook-shortcuts-view");
    const canvas = this.#renderSection(
      "canvas",
      "Canvas shortcuts",
      "Configure device-local bindings used while an Inkbook canvas is active.",
    );
    canvas.classList.add("inkbook-shortcut-section-content-canvas");
    this.#recordingView.renderActions(canvas.createDiv({ cls: "inkbook-shortcuts-list" }));
    this.#renderFixedSection();
    this.#renderGestureSection();
    this.#renderCommandSection();
    this.#recordingView.renderGroupResetAction(this.#container);
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

  #renderFixedSection(): void {
    const content = this.#renderReferenceSection(
      "fixed",
      "Fixed system shortcuts",
      "Review protected editing and accessibility bindings that remain consistent.",
    );
    this.#referenceView.renderFixed(content);
  }

  #renderGestureSection(): void {
    const content = this.#renderReferenceSection(
      "gestures",
      "Pointer and gesture modifiers",
      "Review modifier keys that temporarily change canvas gestures.",
    );
    this.#referenceView.renderGestures(content);
  }

  #renderCommandSection(): void {
    const content = this.#renderReferenceSection(
      "commands",
      "Obsidian commands",
      "Assign these plugin commands from Obsidian's Hotkeys settings.",
    );
    this.#referenceView.renderCommands(content);
  }

  #renderReferenceSection(id: ShortcutSectionId, name: string, description: string): HTMLElement {
    const content = this.#renderSection(id, name, description);
    content.classList.add("inkbook-shortcut-section-content-reference");
    return content;
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
