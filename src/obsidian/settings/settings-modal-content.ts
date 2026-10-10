import { SettingGroup, type App } from "obsidian";

import type { AdaptivePanelContentLifecycle } from "../menus/panel-page";

import { createObsidianHotkeyAccess } from "./obsidian-hotkey-conflicts";
import { SettingDefinitionRenderer } from "./setting-definition-renderer";
import type { InkbookSettingTab } from "./setting-tab";
import { mountShortcutSettingsView } from "./shortcut-definitions";
import type { ShortcutSettingsView } from "./shortcut-view";
import type { InkbookSettingsStore } from "./storage";

export type InkbookSettingsView = "settings" | "shortcuts";

const STRUCTURAL_SETTING_KEYS = new Set(["filePlacement.mode"]);

interface SettingsModalContentOptions {
  readonly app: App;
  readonly settingTab: InkbookSettingTab;
  readonly store: InkbookSettingsStore;
  readonly view: InkbookSettingsView;
  readonly lifecycle?: AdaptivePanelContentLifecycle;
}

/** Owns settings controls independently of the modal or sheet that presents them. */
export class SettingsModalContent {
  readonly #container: HTMLElement;
  readonly #options: SettingsModalContentOptions;
  #definitionRenderer: SettingDefinitionRenderer | undefined;
  #shortcutView: ShortcutSettingsView | undefined;
  readonly #unsubscribeUpdates: (() => void) | undefined;
  #disposed = false;

  public constructor(container: HTMLElement, options: SettingsModalContentOptions) {
    this.#container = container;
    this.#options = options;
    this.#render();
    this.#unsubscribeUpdates =
      options.view === "settings"
        ? options.settingTab.subscribeUpdates(() => {
            if (!this.#disposed) this.#renderPreservingScroll();
          })
        : undefined;
  }

  public dispose(): void {
    this.#disposed = true;
    this.#unsubscribeUpdates?.();
    this.#disposeControls();
  }

  #render(): void {
    this.#disposeControls();
    this.#container.replaceChildren();
    const { app, settingTab, store, view } = this.#options;
    const body = this.#container.createDiv({ cls: "inkbook-settings-modal-body" });
    body.dataset.view = view;
    if (view === "shortcuts") {
      new SettingGroup(body).addSetting((setting) => {
        this.#shortcutView = mountShortcutSettingsView(
          setting,
          store,
          createObsidianHotkeyAccess(app),
          (ownerWindow) => settingTab.scheduler(ownerWindow),
        );
      });
      return;
    }
    this.#definitionRenderer = new SettingDefinitionRenderer(settingTab, (key) => {
      if (!this.#disposed && (key === undefined || STRUCTURAL_SETTING_KEYS.has(key))) {
        this.#renderPreservingScroll();
      }
    });
    this.#definitionRenderer.render(body, settingTab.getSettingDefinitions());
  }

  #renderPreservingScroll(): void {
    const scrollTop = this.#container.scrollTop;
    this.#options.lifecycle?.prepareLayoutChange();
    this.#render();
    this.#container.scrollTop = scrollTop;
    this.#options.lifecycle?.requestLayout();
  }

  #disposeControls(): void {
    this.#definitionRenderer?.dispose();
    this.#definitionRenderer = undefined;
    this.#shortcutView?.dispose();
    this.#shortcutView = undefined;
  }
}
