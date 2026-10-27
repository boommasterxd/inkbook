// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";

import { Modal, Platform, type App, type Plugin } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type {
  PhoneSheetNavigation,
  PhoneSheetPage,
} from "../../../../src/obsidian/menus/panels/panel-page";
import { InkbookSettingTab } from "../../../../src/obsidian/settings/setting-tab";
import { InkbookSettingsModalController } from "../../../../src/obsidian/settings/settings-modal";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { createAdaptivePanelFixture } from "../../../adapters/obsidian/adaptive-panel";
import { createTestSettingsStore } from "../../../fixtures/obsidian/settings-store";

beforeEach(installObsidianDomHelpers);
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  Platform.isPhone = false;
  Platform.isMobile = false;
  vi.useRealTimers();
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

  it("edits settings in the same sheet and commits structural layout changes", async () => {
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
    expect(lifecycle.mutateLayout).toHaveBeenCalledOnce();
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
});

describe("recording cleanup in the real phone sheet layout", () => {
  it.each(["back", "replace"])("releases recorder portals before a phone page %s", async (exit) => {
    vi.useFakeTimers();
    Platform.isPhone = true;
    Platform.isMobile = true;
    const { controller, store, navigation } = setup();
    const sheet = createAdaptivePanelFixture("style", { motion: "full" });
    vi.advanceTimersToNextFrame();
    vi.advanceTimersByTime(220);
    const phoneNavigation = sheet.session.navigation!;
    const leases: Array<Mock<() => void>> = [];
    const active = new Set<() => void>();
    const subscribe = store.subscribeDeviceSettings.bind(store);
    vi.spyOn(store, "subscribeDeviceSettings").mockImplementation((listener) => {
      const cleanup = subscribe(listener);
      const release = vi.fn((): void => {
        cleanup();
        active.delete(release);
      });
      leases.push(release);
      active.add(release);
      return release;
    });
    const errors = vi.spyOn(console, "error");
    try {
      controller.open("shortcuts", phoneNavigation);
      required<HTMLButtonElement>(
        '.inkbook-shortcut-section-trigger[aria-expanded="false"]',
      ).click();
      const selector = 'button[data-shortcut-action="copy"]';
      required<HTMLButtonElement>(selector).click();
      required<HTMLButtonElement>(selector).dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "k", ctrlKey: true }),
      );
      expect(store.getDeviceSettings().keyboardShortcuts.copy).toEqual({
        key: "k",
        modifiers: ["mod"],
      });
      required<HTMLButtonElement>(selector).click();
      required<HTMLButtonElement>(selector).dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
      );
      expect(document.querySelectorAll(".inkbook-shortcut-transition").length).toBeGreaterThan(0);
      const ownedBeforeBack = [...active];
      if (exit === "back") {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
        );
        expect(document.querySelector(".inkbook-shortcuts-view")).toBeNull();
        expect(sheet.control.isConnected).toBe(true);
        expect(active.size).toBe(0);
      } else {
        controller.open("settings", phoneNavigation);
        expect(document.querySelector('[data-view="settings"]')).not.toBeNull();
      }
      await Promise.resolve();
      for (const release of ownedBeforeBack) expect(release).toHaveBeenCalledOnce();
      expect(document.querySelector(".inkbook-shortcut-transition")).toBeNull();
    } finally {
      controller.dispose();
      sheet.session.close("immediate");
    }
    expect(active.size).toBe(0);
    for (const release of leases) expect(release).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
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
    mutateLayout: ReturnType<typeof vi.fn<(update: () => void) => void>>;
  };
} {
  const container = document.body.createDiv();
  const app = { workspace: { containerEl: container } } as unknown as App;
  const store = createTestSettingsStore();
  const controller = new InkbookSettingsModalController(
    app,
    new InkbookSettingTab(app, {} as Plugin, store, undefined, undefined, {
      workScheduler: () => workSchedulerFromFrames(window),
    }),
    store,
  );
  const lifecycle = { mutateLayout: vi.fn((update: () => void) => update()) };
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
