import { SettingGroup, type App } from "obsidian";

import type { AdaptivePanelContentLifecycle } from "../menus/panels/panel-page";

import { createObsidianHotkeyAccess } from "./shortcuts/obsidian-hotkey-conflicts";
import { SettingDefinitionRenderer } from "./setting-definition-renderer";
import type { InkbookSettingTab } from "./setting-tab";
import { mountShortcutSettingsView } from "./shortcuts/shortcut-definitions";
import type { ShortcutSettingsView } from "./shortcuts/shortcut-view";
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
          app.keymap,
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
    this.#definitionRenderer.render(body, settingTab.getControlDefinitions());
  }

  #renderPreservingScroll(): void {
    const update = (): void => this.#replacePreservingScroll();
    if (this.#options.lifecycle === undefined) update();
    else this.#options.lifecycle.mutateLayout(update);
  }

  #replacePreservingScroll(): void {
    const scrollTop = this.#container.scrollTop;
    const focused = this.#container.ownerDocument.activeElement;
    const row = this.#container.contains(focused)
      ? focused?.closest<HTMLElement>("[data-inkbook-setting-identity]")
      : undefined;
    const identity = row?.dataset.inkbookSettingIdentity;
    const restoreRow = focused === row;
    this.#render();
    if (identity !== undefined) {
      const replacement = [
        ...this.#container.querySelectorAll<HTMLElement>("[data-inkbook-setting-identity]"),
      ].find((element) => element.dataset.inkbookSettingIdentity === identity);
      const target = restoreRow
        ? replacement
        : [
            ...(replacement?.querySelectorAll<HTMLElement>("button, input, select, [tabindex]") ??
              []),
          ].find(
            (element) =>
              element.tagName === focused?.tagName &&
              element.getAttribute("aria-label") === focused.getAttribute("aria-label"),
          );
      target?.focus({ preventScroll: true });
    }
    this.#container.scrollTop = scrollTop;
  }

  #disposeControls(): void {
    this.#definitionRenderer?.dispose();
    this.#definitionRenderer = undefined;
    this.#shortcutView?.dispose();
    this.#shortcutView = undefined;
  }
}
