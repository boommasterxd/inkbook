// @vitest-environment happy-dom

import { Modal, type App, type Plugin } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PhoneSheetNavigation,
  PhoneSheetPage,
} from "../../../../src/obsidian/menus/panel-page";
import { InkbookSettingTab } from "../../../../src/obsidian/settings/setting-tab";
import { InkbookSettingsModalController } from "../../../../src/obsidian/settings/settings-modal";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { createTestSettingsStore } from "../../../fixtures/obsidian/settings-store";

beforeEach(installObsidianDomHelpers);
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("settings pages in an existing phone sheet", () => {
  it("replaces a pending page in the same sheet without closing it or losing new ownership", () => {
    const { controller, navigation } = setup();
    let pending: PhoneSheetPage | undefined;
    vi.spyOn(navigation, "push").mockImplementation((next) => {
      pending?.dispose?.();
      pending = next;
    });
    controller.open("settings", navigation);
    controller.open("shortcuts", navigation);
    expect(navigation.close).not.toHaveBeenCalled();
    expect(pending?.label).toBe("Keyboard shortcuts");
    controller.dispose();
    expect(navigation.close).toHaveBeenCalledExactlyOnceWith("immediate");
    pending?.dispose?.();
  });

  it("edits settings and requests a measured resize for structural changes without another modal", async () => {
    const { controller, store, navigation, lifecycle } = setup();
    const open = vi.spyOn(Modal.prototype, "open");
    controller.open("settings", navigation);
    expect(open).not.toHaveBeenCalled();
    expect(document.querySelector(".inkbook-settings-modal.inkbook-phone-dialog")).not.toBeNull();
    const dropdown = required<HTMLSelectElement>('[data-setting-name="File placement"] select');
    dropdown.value = "custom-vault-folder";
    dropdown.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => {
      expect(store.getVaultSettings().filePlacement.mode).toBe("custom-vault-folder");
      expect(document.querySelector('[data-setting-name="Custom vault folder"]')).not.toBeNull();
    });
    expect(lifecycle.prepareLayoutChange).toHaveBeenCalledOnce();
    expect(lifecycle.requestLayout).toHaveBeenCalledOnce();
    controller.dispose();
    expect(navigation.close).toHaveBeenCalledExactlyOnceWith("immediate");
    expect(document.querySelector(".inkbook-settings-modal")).toBeNull();
    open.mockRestore();
  });

  it("releases page ownership on Back so later controller disposal leaves the parent sheet open", () => {
    const { controller, navigation } = setup();
    controller.open("settings", navigation);
    expect(navigation.back()).toBe(true);
    controller.dispose();
    expect(navigation.close).not.toHaveBeenCalled();
  });

  it("records shortcuts and releases subscriptions and active recording when leaving the page", () => {
    const { controller, store, navigation } = setup();
    const unsubscribe = vi.fn();
    const subscribe = store.subscribeDeviceSettings.bind(store);
    vi.spyOn(store, "subscribeDeviceSettings").mockImplementation((listener) => {
      const cleanup = subscribe(listener);
      return () => {
        cleanup();
        unsubscribe();
      };
    });
    controller.open("shortcuts", navigation);
    const selector = 'button[aria-label="Change shortcut for Copy selection"]';
    required<HTMLButtonElement>(selector).click();
    required<HTMLButtonElement>(selector).dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "k", ctrlKey: true }),
    );
    expect(store.getDeviceSettings().keyboardShortcuts.copy).toEqual({
      key: "k",
      modifiers: ["mod"],
    });
    required<HTMLButtonElement>(selector).click();
    navigation.back();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(document.querySelector(".inkbook-shortcuts-view")).toBeNull();
    controller.dispose();
    expect(navigation.close).not.toHaveBeenCalled();
  });
});

function setup(): {
  controller: InkbookSettingsModalController;
  store: ReturnType<typeof createTestSettingsStore>;
  navigation: Omit<PhoneSheetNavigation, "close"> & {
    close: ReturnType<typeof vi.fn<PhoneSheetNavigation["close"]>>;
  };
  lifecycle: {
    prepareLayoutChange: ReturnType<typeof vi.fn>;
    requestLayout: ReturnType<typeof vi.fn>;
  };
} {
  const container = document.body.createDiv();
  const app = { workspace: { containerEl: container } } as unknown as App;
  const store = createTestSettingsStore();
  const controller = new InkbookSettingsModalController(
    app,
    new InkbookSettingTab(app, {} as Plugin, store),
    store,
  );
  const lifecycle = { prepareLayoutChange: vi.fn(), requestLayout: vi.fn() };
  let page: PhoneSheetPage | undefined;
  const back = (): boolean => {
    if (page === undefined) return false;
    page.dispose?.();
    page = undefined;
    container.replaceChildren();
    return true;
  };
  const navigation = {
    ownerDocument: document,
    push: (next: PhoneSheetPage): void => {
      page = next;
      container.append(next.createContent(lifecycle));
    },
    back,
    close: vi.fn<PhoneSheetNavigation["close"]>(() => {
      back();
    }),
  };
  return { controller, store, navigation, lifecycle };
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing ${selector}.`);
  return element;
}
