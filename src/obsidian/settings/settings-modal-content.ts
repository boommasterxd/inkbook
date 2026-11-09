import { SettingGroup, type App } from "obsidian";

import type { AdaptivePanelContentLifecycle } from "../menus/panels/panel-page";

import { createObsidianHotkeyAccess } from "./shortcuts/obsidian-hotkey-conflicts";
import { SettingDefinitionRenderer } from "./setting-definition-renderer";
import type { InkbookSettingTab } from "./setting-tab";
import { mountShortcutSettingsView } from "./shortcuts/shortcut-definitions";
import type { ShortcutSettingsView } from "./shortcuts/shortcut-view";
import type { InkbookSettingsStore } from "./storage";
import { SettingsViewState } from "./settings-view-state";
import { refreshSettingsView } from "./settings-view-refresh";

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
  readonly #body: HTMLElement;
  readonly #options: SettingsModalContentOptions;
  readonly #viewState = new SettingsViewState();
  #definitionRenderer: SettingDefinitionRenderer | undefined;
  #shortcutView: ShortcutSettingsView | undefined;
  readonly #unsubscribeUpdates: (() => void) | undefined;
  #disposed = false;

  public constructor(container: HTMLElement, options: SettingsModalContentOptions) {
    this.#options = options;
    container.replaceChildren();
    this.#body = container.createDiv({ cls: "inkbook-settings-modal-body" });
    this.#body.dataset.view = options.view;
    this.#render();
    this.#unsubscribeUpdates = options.settingTab.subscribeUpdates(() => {
      if (!this.#disposed) this.#renderPreservingScroll();
    });
  }

  public dispose(): void {
    this.#disposed = true;
    this.#unsubscribeUpdates?.();
    this.#disposeControls();
  }

  #render(): void {
    this.#disposeControls();
    this.#body.replaceChildren();
    const { app, settingTab, store, view } = this.#options;
    const body = this.#body;
    if (view === "shortcuts") {
      new SettingGroup(body).addSetting((setting) => {
        this.#shortcutView = mountShortcutSettingsView(
          setting,
          store,
          app.keymap,
          createObsidianHotkeyAccess(app),
          (ownerWindow) => settingTab.scheduler(ownerWindow),
          this.#viewState,
        );
      });
      return;
    }
    this.#definitionRenderer = new SettingDefinitionRenderer(settingTab, (key) => {
      if (!this.#disposed && (key === undefined || STRUCTURAL_SETTING_KEYS.has(key))) {
        this.#renderPreservingScroll();
      }
    });
    this.#definitionRenderer.render(body, settingTab.getControlDefinitions(this.#viewState));
  }

  #renderPreservingScroll(): void {
    const update = (): void => refreshSettingsView(this.#body, () => this.#render());
    if (this.#options.lifecycle === undefined) update();
    else this.#options.lifecycle.mutateLayout(update);
  }

  #disposeControls(): void {
    this.#definitionRenderer?.dispose();
    this.#definitionRenderer = undefined;
    this.#shortcutView?.dispose();
    this.#shortcutView = undefined;
  }
}
