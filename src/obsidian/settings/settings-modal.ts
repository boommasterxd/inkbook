import { bindElementLanguage } from "../../rendering/localization/element-language";
import type { App } from "obsidian";

import { InkbookMotionModal } from "../dialogs/inkbook-motion-modal";
import { menuDomWindow } from "../menus/menu-dom";
import type { PhoneSheetNavigation, PhoneSheetPage } from "../menus/panels/panel-page";

import type { InkbookSettingTab } from "./setting-tab";
import { SettingsModalContent, type InkbookSettingsView } from "./settings-modal-content";
import type { InkbookSettingsStore } from "./storage";

export type { InkbookSettingsView } from "./settings-modal-content";

export class InkbookSettingsModalController {
  readonly #app: App;
  #modal: InkbookSettingsModal | undefined;
  #navigation: PhoneSheetNavigation | undefined;
  #page: PhoneSheetPage | undefined;
  readonly #settingTab: InkbookSettingTab;
  readonly #store: InkbookSettingsStore;

  public constructor(app: App, settingTab: InkbookSettingTab, store: InkbookSettingsStore) {
    this.#app = app;
    this.#settingTab = settingTab;
    this.#store = store;
  }

  public dispose(): void {
    this.#modal?.closeImmediately();
    this.#modal = undefined;
    const navigation = this.#navigation;
    this.#navigation = undefined;
    this.#page = undefined;
    navigation?.close("immediate");
  }

  public open(view: InkbookSettingsView, navigation?: PhoneSheetNavigation): void {
    if (navigation === undefined || this.#navigation !== navigation) this.dispose();
    if (navigation !== undefined) {
      this.#openPage(view, navigation);
      return;
    }
    let modal: InkbookSettingsModal;
    modal = new InkbookSettingsModal(this.#app, this.#settingTab, this.#store, view, () => {
      if (this.#modal === modal) this.#modal = undefined;
    });
    this.#modal = modal;
    modal.open();
  }

  #openPage(view: InkbookSettingsView, navigation: PhoneSheetNavigation): void {
    let content: SettingsModalContent | undefined;
    const page: PhoneSheetPage = {
      kind: "dialog",
      label: viewTitle(view, this.#store),
      readLabel: () => viewTitle(view, this.#store),
      subscribeLabel: (listener) => this.#store.localization.subscribe(listener),
      createContent: (lifecycle) => {
        const fragment = menuDomWindow(navigation.ownerDocument, "settings page").createFragment();
        const wrapper = fragment.createDiv({ cls: "inkbook-settings-modal inkbook-phone-dialog" });
        const body = wrapper.createDiv({ cls: "inkbook-phone-dialog-content" });
        content = new SettingsModalContent(body, {
          app: this.#app,
          settingTab: this.#settingTab,
          store: this.#store,
          view,
          lifecycle,
        });
        return fragment;
      },
      dispose: () => {
        content?.dispose();
        content = undefined;
        if (this.#page === page) {
          this.#page = undefined;
          this.#navigation = undefined;
        }
      },
    };
    this.#navigation = navigation;
    this.#page = page;
    navigation.push(page);
  }
}

class InkbookSettingsModal extends InkbookMotionModal {
  #content: SettingsModalContent | undefined;
  #unsubscribeLanguage: (() => void) | undefined;
  readonly #onClosed: () => void;
  readonly #settingTab: InkbookSettingTab;
  readonly #store: InkbookSettingsStore;
  readonly #view: InkbookSettingsView;

  public constructor(
    app: App,
    settingTab: InkbookSettingTab,
    store: InkbookSettingsStore,
    view: InkbookSettingsView,
    onClosed: () => void,
  ) {
    super(
      app,
      () => store.getDeviceSettings().motion,
      (ownerWindow) => settingTab.scheduler(ownerWindow),
      (listener) => store.subscribeDeviceSettings(listener),
    );
    this.#onClosed = onClosed;
    this.#settingTab = settingTab;
    this.#store = store;
    this.#view = view;
  }

  public override onOpen(): void {
    super.onOpen();
    this.modalEl.classList.add("inkbook-settings-modal");
    this.setTitle(viewTitle(this.#view, this.#store));
    const releaseLanguage = bindElementLanguage(this.modalEl, this.#store.localization);
    const unsubscribe = this.#store.localization.subscribe(() =>
      this.setTitle(viewTitle(this.#view, this.#store)),
    );
    this.#unsubscribeLanguage = () => {
      unsubscribe();
      releaseLanguage();
    };
    this.#content = new SettingsModalContent(this.contentEl, {
      app: this.app,
      settingTab: this.#settingTab,
      store: this.#store,
      view: this.#view,
    });
  }

  public override onClose(): void {
    super.onClose();
    this.#unsubscribeLanguage?.();
    this.#content?.dispose();
    this.#content = undefined;
    this.contentEl.replaceChildren();
    this.#onClosed();
  }
}

function viewTitle(view: InkbookSettingsView, store: InkbookSettingsStore): string {
  return store.localization.t(view === "settings" ? "settings.title" : "settings.shortcutsTitle");
}
