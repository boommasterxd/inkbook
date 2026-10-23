// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";

import type { App, Plugin } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InkbookSettingTab } from "../../../../src/obsidian/settings/setting-tab";
import { InkbookSettingsModalController } from "../../../../src/obsidian/settings/settings-modal";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { createTestSettingsStore } from "../../../fixtures/obsidian/settings-store";
import * as actionDialog from "../../../../src/obsidian/dialogs/action-dialog";

beforeEach(() => {
  installObsidianDomHelpers();
  document.body.replaceChildren();
});

describe("Inkbook settings modal", () => {
  it("opens each requested view without an in-modal view switcher", () => {
    const workspaceContainer = document.body.createDiv();
    const app = { workspace: { containerEl: workspaceContainer } } as unknown as App;
    const plugin = {} as Plugin;
    const store = createTestSettingsStore();
    const tab = new InkbookSettingTab(app, plugin, store, undefined, undefined, {
      workScheduler: () => workSchedulerFromFrames(window),
    });
    const controller = new InkbookSettingsModalController(app, tab, store);

    controller.open("shortcuts");

    expect(required(".inkbook-settings-modal").getAttribute("aria-label")).toBe(
      "Keyboard shortcuts",
    );
    expect(document.querySelector(".inkbook-settings-modal-tabs")).toBeNull();
    expect(document.querySelectorAll(".inkbook-shortcut-row")).toHaveLength(10);
    expect(
      document.querySelectorAll('.inkbook-shortcut-section-trigger[aria-expanded="false"]'),
    ).toHaveLength(4);
    controller.open("settings");
    expect(required(".inkbook-settings-modal").getAttribute("aria-label")).toBe("Inkbook settings");
    expect(document.querySelector(".setting-group")).not.toBeNull();
    expect(document.querySelector(".inkbook-shortcuts-group")).not.toBeNull();
    const resetAll = required<HTMLElement>('[data-setting-name="Reset all Inkbook settings"]');
    expect(resetAll.classList).toContain("mod-action");
    expect(resetAll.getAttribute("role")).toBe("button");
    expect(resetAll.querySelector("button")).toBeNull();
    expect(resetAll.dataset.inkbookSettingActionTone).toBe("danger");
    for (const reset of document.querySelectorAll<HTMLElement>(
      '[data-setting-name="Reset group to defaults"]',
    )) {
      expect(reset.dataset.inkbookSettingActionTone).toBe("caution");
    }

    controller.dispose();
    expect(document.querySelector(".inkbook-settings-modal")).toBeNull();
  });

  it("animates the snapping subsettings without discarding their values", async () => {
    const { controller, store } = openSettingsModalWithFullMotion();
    const dependentRows = [
      "Angle snapping",
      "Bend snapping",
      "Connection snapping",
      "Structure snapping",
    ].map((name) => required<HTMLElement>(`[data-setting-name="${name}"]`));
    for (const row of dependentRows) {
      expect(row.querySelector(".setting-item")).toBeNull();
      expect(row.querySelector('input[type="checkbox"]')).toBeTruthy();
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue(rectWithHeight(56));
    }
    const enabledRow = required<HTMLElement>('[data-setting-name="Enable snapping"]');
    const toggle = requiredWithin<HTMLInputElement>(enabledRow, 'input[type="checkbox"]');
    expect(toggle.getAttribute("aria-label")).toBe("Enable snapping");
    for (const row of dependentRows) {
      expect(row.querySelector("input")?.getAttribute("aria-label")).toBe(row.dataset.settingName);
    }
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(store.getVaultSettings().snapping.enabled).toBe(false));
    for (const row of dependentRows) {
      await vi.waitFor(() => expect(row.hidden).toBe(true));
      expect(row.inert).toBe(true);
    }
    expect(store.getVaultSettings().snapping.angles).toBe(true);
    controller.dispose();
  });
});

describe("Inkbook settings modal scroll preservation", () => {
  it("keeps the settings scroll position when ordinary controls change", async () => {
    const { controller, store } = openSettingsModalWithFullMotion();
    const modalContent = required<HTMLElement>(".inkbook-settings-modal > div");
    const body = required<HTMLElement>(".inkbook-settings-modal-body");
    const row = required<HTMLElement>('[data-setting-name="Left-handed toolbar"]');
    const toggle = requiredWithin<HTMLInputElement>(row, 'input[type="checkbox"]');
    modalContent.scrollTop = 640;

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(store.getDeviceSettings().leftHandedToolbar).toBe(true));
    expect(modalContent.scrollTop).toBe(640);
    expect(required<HTMLElement>(".inkbook-settings-modal-body")).toBe(body);
    expect(required<HTMLElement>('[data-setting-name="Left-handed toolbar"]')).toBe(row);
    controller.dispose();
  });

  it("preserves scroll while rerendering structurally conditional settings", async () => {
    const { controller, store } = openSettingsModalWithFullMotion();
    const modalContent = required<HTMLElement>(".inkbook-settings-modal > div");
    const row = required<HTMLElement>('[data-setting-name="File placement"]');
    const dropdown = requiredWithin<HTMLSelectElement>(row, "select");
    expect(dropdown.getAttribute("aria-label")).toBe("File placement");
    dropdown.focus();
    modalContent.scrollTop = 320;

    dropdown.value = "custom-vault-folder";
    dropdown.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() =>
      expect(store.getVaultSettings().filePlacement.mode).toBe("custom-vault-folder"),
    );
    expect(required<HTMLElement>('[data-setting-name="Custom vault folder"]')).toBeTruthy();
    expect(modalContent.scrollTop).toBe(320);
    expect(document.activeElement).toBe(required('[aria-label="File placement"]'));
    controller.dispose();
  });
});

describe("Inkbook settings modal reset refresh", () => {
  it.each(["group", "all"])(
    "refreshes the open preload controls after a %s reset",
    async (scope) => {
      const { controller, store } = openSettingsModalWithFullMotion();
      const modalContent = required<HTMLElement>(".inkbook-settings-modal > div");
      const pixelSelector = '[data-control="scroll-preload-margin"]';
      const slider = required<HTMLInputElement>(`${pixelSelector} input[type="range"]`);
      const refreshSelector = '[data-setting-name="Display refresh rate"] select';
      const highlightSelector = '[data-setting-name="Selection highlights"] input';
      const refresh = required<HTMLSelectElement>(refreshSelector);
      const highlights = required<HTMLInputElement>(highlightSelector);
      refresh.value = "60";
      refresh.dispatchEvent(new Event("change", { bubbles: true }));
      highlights.checked = false;
      highlights.dispatchEvent(new Event("change", { bubbles: true }));
      slider.value = "800";
      slider.dispatchEvent(new Event("input"));
      slider.dispatchEvent(new Event("change"));
      await vi.waitFor(() => {
        expect(store.getDeviceSettings().scrollPreloadMarginPx).toBe(800);
        expect(store.getVaultSettings().refreshRatePreference).toBe(60);
        expect(store.getVaultSettings().selectionHighlightsEnabled).toBe(false);
      });
      modalContent.scrollTop = 240;
      vi.spyOn(actionDialog, "confirmInkbookAction").mockResolvedValue(true);
      const reset =
        scope === "all"
          ? required<HTMLElement>('[data-setting-name="Reset all Inkbook settings"]')
          : required<HTMLElement>(
              '.inkbook-settings-performance-group [data-setting-name="Reset group to defaults"]',
            );

      reset.focus();
      reset.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );

      await vi.waitFor(() => {
        expect(store.getDeviceSettings().scrollPreloadMarginPx).toBe(300);
        expect(store.getVaultSettings().refreshRatePreference).toBe("auto");
        expect(store.getVaultSettings().selectionHighlightsEnabled).toBe(true);
        expect(required<HTMLSelectElement>(refreshSelector).value).toBe("auto");
        expect(required<HTMLInputElement>(highlightSelector).checked).toBe(true);
        expect(required<HTMLInputElement>(`${pixelSelector} input[type="range"]`).value).toBe(
          "300",
        );
        expect(required<HTMLInputElement>(`${pixelSelector} input[type="number"]`).value).toBe(
          "300",
        );
      });
      expect(modalContent.scrollTop).toBe(240);
      expect(document.activeElement).toBe(
        scope === "all"
          ? required('[data-setting-name="Reset all Inkbook settings"]')
          : required(
              '.inkbook-settings-performance-group [data-setting-name="Reset group to defaults"]',
            ),
      );
      controller.dispose();
      vi.restoreAllMocks();
    },
  );

  it("releases the tab update listener when the settings modal closes", () => {
    const { controller, tab } = openSettingsModalWithFullMotion();
    const modalContent = required<HTMLElement>(".inkbook-settings-modal > div");
    controller.dispose();
    const replace = vi.spyOn(modalContent, "replaceChildren");
    tab.update();
    expect(replace).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("Inkbook settings disclosure motion", () => {
  it("finishes a reversed disclosure only when the new transition completes", async () => {
    const { controller } = openSettingsModalWithFullMotion();
    const trigger = required<HTMLButtonElement>(
      '.inkbook-settings-tool-trigger[aria-expanded="false"]',
    );
    const panel = required<HTMLElement>(`#${trigger.getAttribute("aria-controls") ?? "missing"}`);
    trigger.click();
    trigger.click();
    expect(panel.hidden).toBe(false);
    expect(panel.inert).toBe(true);
    await vi.waitFor(() => expect(panel.hidden).toBe(true));
    controller.dispose();
  });

  it("animates every tool and shortcut section while opening and closing", async () => {
    const { controller } = openSettingsModalWithFullMotion();
    const triggers = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '.inkbook-settings-tool-trigger[aria-expanded="false"]',
      ),
    ];
    expect(triggers).toHaveLength(19);

    const panels = triggers.map((trigger) => {
      const panel = required<HTMLElement>(`#${trigger.getAttribute("aria-controls") ?? "missing"}`);
      trigger.click();
      expect(panel.hidden).toBe(false);
      expect(panel.inert).toBe(false);
      return panel;
    });

    for (const [index, panel] of panels.entries()) {
      triggers[index]?.click();
      expect(panel.hidden).toBe(false);
      expect(panel.inert).toBe(true);
    }
    await vi.waitFor(() => expect(panels.every((panel) => panel.hidden)).toBe(true));
    controller.dispose();
  });
});

function openSettingsModalWithFullMotion(): {
  controller: InkbookSettingsModalController;
  store: ReturnType<typeof createTestSettingsStore>;
  tab: InkbookSettingTab;
} {
  const workspaceContainer = document.body.createDiv();
  const app = { workspace: { containerEl: workspaceContainer } } as unknown as App;
  const store = createTestSettingsStore();
  store.updateDeviceSettings((settings) => ({ ...settings, motion: "full" }));
  const tab = new InkbookSettingTab(app, {} as Plugin, store, undefined, undefined, {
    workScheduler: () => workSchedulerFromFrames(window),
  });
  const controller = new InkbookSettingsModalController(app, tab, store);
  controller.open("settings");
  return { controller, store, tab };
}

function required<T extends Element = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing ${selector}.`);
  return element;
}

function requiredWithin<T extends Element>(container: ParentNode, selector: string): T {
  const element = container.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing ${selector}.`);
  return element;
}

function rectWithHeight(height: number): DOMRect {
  return {
    bottom: height,
    height,
    left: 0,
    right: 600,
    top: 0,
    width: 600,
    x: 0,
    y: 0,
    toJSON: () => undefined,
  };
}
