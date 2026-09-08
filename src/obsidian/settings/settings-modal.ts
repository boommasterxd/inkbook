import { Modal, SettingGroup, type App } from "obsidian";

import { SettingDefinitionRenderer } from "./setting-definition-renderer";
import type { InkbookSettingTab } from "./setting-tab";
import { mountShortcutSettingsView } from "./shortcut-definitions";
import type { ShortcutSettingsView } from "./shortcut-view";
import type { InkbookSettingsStore } from "./storage";
import { createObsidianHotkeyAccess } from "./obsidian-hotkey-conflicts";

export type InkbookSettingsView = "settings" | "shortcuts";

const STRUCTURAL_SETTING_KEYS = new Set(["filePlacement.mode"]);

export class InkbookSettingsModalController {
  readonly #app: App;
  #modal: InkbookSettingsModal | undefined;
  readonly #settingTab: InkbookSettingTab;
  readonly #store: InkbookSettingsStore;

  public constructor(app: App, settingTab: InkbookSettingTab, store: InkbookSettingsStore) {
    this.#app = app;
    this.#settingTab = settingTab;
    this.#store = store;
  }

  public dispose(): void {
    this.#modal?.close();
    this.#modal = undefined;
  }

  public open(view: InkbookSettingsView): void {
    this.#modal?.close();
    let modal: InkbookSettingsModal;
    modal = new InkbookSettingsModal(this.#app, this.#settingTab, this.#store, view, () => {
      if (this.#modal === modal) this.#modal = undefined;
    });
    this.#modal = modal;
    modal.open();
  }
}

class InkbookSettingsModal extends Modal {
  #definitionRenderer: SettingDefinitionRenderer | undefined;
  readonly #onClosed: () => void;
  readonly #settingTab: InkbookSettingTab;
  #shortcutView: ShortcutSettingsView | undefined;
  readonly #store: InkbookSettingsStore;
  readonly #view: InkbookSettingsView;

  public constructor(
    app: App,
    settingTab: InkbookSettingTab,
    store: InkbookSettingsStore,
    view: InkbookSettingsView,
    onClosed: () => void,
  ) {
    super(app);
    this.#onClosed = onClosed;
    this.#settingTab = settingTab;
    this.#store = store;
    this.#view = view;
  }

  public override onOpen(): void {
    this.modalEl.classList.add("inkbook-settings-modal");
    this.setTitle(this.#view === "settings" ? "Inkbook settings" : "Keyboard shortcuts");
    this.#render();
  }

  public override onClose(): void {
    this.#disposeContent();
    this.contentEl.replaceChildren();
    this.#onClosed();
  }

  #render(): void {
    this.#disposeContent();
    this.contentEl.replaceChildren();
    const body = this.contentEl.createDiv({ cls: "inkbook-settings-modal-body" });
    body.dataset.view = this.#view;
    if (this.#view === "shortcuts") {
      new SettingGroup(body).addSetting((setting) => {
        this.#shortcutView = mountShortcutSettingsView(
          setting,
          this.#store,
          createObsidianHotkeyAccess(this.app),
        );
      });
      return;
    }
    const rerenderIfRequired = (key: string | undefined): void => {
      if (key === undefined || STRUCTURAL_SETTING_KEYS.has(key)) this.#renderPreservingScroll();
    };
    this.#definitionRenderer = new SettingDefinitionRenderer(this.#settingTab, rerenderIfRequired);
    this.#definitionRenderer.render(body, this.#settingTab.getSettingDefinitions());
  }

  #renderPreservingScroll(): void {
    const scrollTop = this.contentEl.scrollTop;
    this.#render();
    this.contentEl.scrollTop = scrollTop;
  }

  #disposeContent(): void {
    this.#definitionRenderer?.dispose();
    this.#definitionRenderer = undefined;
    this.#shortcutView?.dispose();
    this.#shortcutView = undefined;
  }
}
