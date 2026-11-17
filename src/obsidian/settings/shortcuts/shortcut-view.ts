import type { Keymap } from "obsidian";
import type { InkbookSettingsStore } from "../storage";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { isReducedMotion } from "../../../rendering/motion/transitions";
import type { ObsidianHotkeyAccess } from "./obsidian-hotkey-conflicts";
import { ShortcutRecordingView } from "./shortcut-recording-view";
import { ShortcutReferenceView } from "./shortcut-reference-view";
import { createSettingsDisclosure } from "../settings-disclosure";
import { SettingsPanelMotion } from "../settings-panel-motion";
import { SettingsViewState } from "../settings-view-state";
import { refreshSettingsView } from "../settings-view-refresh";

type ShortcutSectionId = "canvas" | "commands" | "fixed" | "gestures";

let shortcutViewSequence = 0;

export class ShortcutSettingsView {
  readonly #container: HTMLElement;
  readonly #viewState: SettingsViewState;
  readonly #idPrefix = `inkbook-shortcuts-${String(++shortcutViewSequence)}`;
  readonly #recordingView: ShortcutRecordingView;
  readonly #referenceView: ShortcutReferenceView;
  readonly #store: InkbookSettingsStore;
  readonly #unsubscribe: () => void;
  readonly #unsubscribeLocale: () => void;
  #disposed = false;
  #panelMotions: SettingsPanelMotion[] = [];
  #disposeDisclosures: Array<() => void> = [];

  public constructor(
    container: HTMLElement,
    store: InkbookSettingsStore,
    keymap: Pick<Keymap, "pushScope" | "popScope">,
    hostHotkeys: ObsidianHotkeyAccess = EMPTY_OBSIDIAN_HOTKEY_ACCESS,
    workScheduler?: (ownerWindow: Window | null) => WorkScheduler,
    viewState = new SettingsViewState(),
  ) {
    this.#container = container;
    this.#store = store;
    this.#viewState = viewState;
    if (workScheduler === undefined) throw new Error("Shortcut settings require a work scheduler.");
    this.#recordingView = new ShortcutRecordingView(container, store, hostHotkeys, keymap);
    this.#referenceView = new ShortcutReferenceView(hostHotkeys, store.localization.t);
    let shortcuts = JSON.stringify(store.getDeviceSettings().keyboardShortcuts);
    this.#unsubscribe = store.subscribeDeviceSettings((settings) => {
      const next = JSON.stringify(settings.keyboardShortcuts);
      if (next === shortcuts) return;
      shortcuts = next;
      this.render();
    });
    this.#unsubscribeLocale = store.localization.subscribe(() => this.render());
    this.render();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.#unsubscribeLocale();
    this.#recordingView.dispose();
    this.#disposePanelMotions();
    this.#container.replaceChildren();
  }

  public render(): void {
    if (this.#disposed) return;
    refreshSettingsView(this.#container, () => this.#renderContent());
  }

  #renderContent(): void {
    this.#recordingView.prepareRender();
    this.#disposePanelMotions();
    this.#container.replaceChildren();
    this.#container.classList.add("inkbook-shortcuts-view");
    this.#renderSection(
      "canvas",
      this.#store.localization.t("settings.shortcuts.canvas"),
      this.#store.localization.t("settings.shortcuts.canvasHelp"),
      (canvas) => {
        canvas.classList.add("inkbook-shortcut-section-content-canvas");
        this.#recordingView.renderActions(canvas.createDiv({ cls: "inkbook-shortcuts-list" }));
        return () => this.#recordingView.activateActions();
      },
    );
    this.#renderFixedSection();
    this.#renderGestureSection();
    this.#renderCommandSection();
    this.#recordingView.renderGroupResetAction(this.#container);
  }

  #renderSection(
    id: ShortcutSectionId,
    name: string,
    description: string,
    render: (content: HTMLElement) => (() => void) | void,
  ): void {
    const panelId = `${this.#idPrefix}-${id}`;
    const stateKey = `shortcut:${id}`;
    const expanded = this.#viewState.expandedSections.has(stateKey);
    let initialized = false;
    let activate: (() => void) | undefined;
    const prepareContent = (): (() => void) | undefined => {
      if (!initialized) {
        activate = render(content) ?? undefined;
        initialized = true;
      }
      return activate;
    };
    const { content, panel, trigger, setExpanded, dispose } = createSettingsDisclosure(
      this.#container,
      {
        contentClass: "inkbook-shortcut-section-content",
        description,
        deferDescriptionUntilExpanded: true,
        expanded,
        panelId,
        readMotion: () => this.#store.getDeviceSettings().motion,
        observeMotion: (listener) => this.#store.subscribeDeviceSettings(listener),
        sectionClass: "inkbook-shortcut-section",
        title: name,
        triggerClass: "inkbook-shortcut-section-trigger",
        prepareContent,
      },
    );
    const motion = new SettingsPanelMotion(
      panel,
      () => this.#store.getDeviceSettings().motion,
      (listener) => this.#store.subscribeDeviceSettings(listener),
    );
    trigger.dataset.inkbookSettingIdentity = JSON.stringify(["shortcut-section", id]);
    this.#panelMotions.push(motion);
    this.#disposeDisclosures.push(dispose);
    if (expanded) {
      prepareContent()?.();
    }
    const toggle = (): void => {
      const nextExpanded = trigger.getAttribute("aria-expanded") !== "true";
      if (nextExpanded) {
        prepareContent()?.();
      }
      trigger.setAttribute("aria-expanded", String(nextExpanded));
      setExpanded(
        nextExpanded,
        isReducedMotion(
          this.#store.getDeviceSettings().motion,
          panel.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches,
        ),
      );
      if (nextExpanded) this.#viewState.expandedSections.add(stateKey);
      else this.#viewState.expandedSections.delete(stateKey);
      motion.setExpanded(nextExpanded);
    };
    trigger.addEventListener("click", toggle);
    this.#disposeDisclosures.push(() => trigger.removeEventListener("click", toggle));
  }

  #renderFixedSection(): void {
    this.#renderReferenceSection(
      "fixed",
      this.#store.localization.t("settings.shortcuts.fixed"),
      this.#store.localization.t("settings.shortcuts.fixedHelp"),
      (content) => this.#referenceView.renderFixed(content),
    );
  }

  #renderGestureSection(): void {
    this.#renderReferenceSection(
      "gestures",
      this.#store.localization.t("settings.shortcuts.gestures"),
      this.#store.localization.t("settings.shortcuts.gesturesHelp"),
      (content) => this.#referenceView.renderGestures(content),
    );
  }

  #renderCommandSection(): void {
    this.#renderReferenceSection(
      "commands",
      this.#store.localization.t("settings.shortcuts.commands"),
      this.#store.localization.t("settings.shortcuts.commandsHelp"),
      (content) => this.#referenceView.prepareCommands(content),
    );
  }

  #renderReferenceSection(
    id: ShortcutSectionId,
    name: string,
    description: string,
    render: (content: HTMLElement) => (() => void) | void,
  ): void {
    this.#renderSection(id, name, description, (content) => {
      content.classList.add("inkbook-shortcut-section-content-reference");
      return render(content);
    });
  }

  #disposePanelMotions(): void {
    for (const motion of this.#panelMotions) motion.dispose();
    this.#panelMotions = [];
    for (const dispose of this.#disposeDisclosures) dispose();
    this.#disposeDisclosures = [];
  }
}

const EMPTY_OBSIDIAN_HOTKEY_ACCESS: ObsidianHotkeyAccess = {
  findConflict: () => undefined,
  readBindings: () => new Map(),
};
