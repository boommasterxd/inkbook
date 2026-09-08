// @vitest-environment happy-dom

import type { App, Plugin } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InkbookSettingTab } from "../../../../src/obsidian/settings/setting-tab";
import { InkbookSettingsModalController } from "../../../../src/obsidian/settings/settings-modal";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { createTestSettingsStore } from "../../../fixtures/obsidian/settings-store";

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
    const tab = new InkbookSettingTab(app, plugin, store);
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
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(store.getVaultSettings().snapping.enabled).toBe(false));
    for (const row of dependentRows) {
      expect(row.dataset.resizing).toBe("true");
      expect(row.hidden).toBe(false);
      await vi.waitFor(() => expect(row.style.blockSize).toBe("0px"));
      row.dispatchEvent(transitionEnd());
      expect(row.hidden).toBe(true);
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
    modalContent.scrollTop = 320;

    dropdown.value = "custom-vault-folder";
    dropdown.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() =>
      expect(store.getVaultSettings().filePlacement.mode).toBe("custom-vault-folder"),
    );
    expect(required<HTMLElement>('[data-setting-name="Custom vault folder"]')).toBeTruthy();
    expect(modalContent.scrollTop).toBe(320);
    controller.dispose();
  });
});

describe("Inkbook settings disclosure motion", () => {
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
      vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(rectWithHeight(64));
      trigger.click();
      expect(panel.hidden).toBe(false);
      expect(panel.dataset.resizing).toBe("true");
      expect(panel.style.blockSize).toBe("0px");
      return panel;
    });
    await vi.waitFor(() => {
      expect(panels.every((panel) => panel.style.blockSize === "64px")).toBe(true);
    });

    for (const [index, panel] of panels.entries()) {
      panel.dispatchEvent(transitionEnd());
      triggers[index]?.click();
      expect(panel.hidden).toBe(false);
      expect(panel.dataset.resizing).toBe("true");
      expect(panel.style.blockSize).toBe("64px");
    }
    await vi.waitFor(() => {
      expect(panels.every((panel) => panel.style.blockSize === "0px")).toBe(true);
    });
    for (const panel of panels) {
      panel.dispatchEvent(transitionEnd());
      expect(panel.hidden).toBe(true);
    }
    controller.dispose();
  });
});

function openSettingsModalWithFullMotion(): {
  controller: InkbookSettingsModalController;
  store: ReturnType<typeof createTestSettingsStore>;
} {
  const workspaceContainer = document.body.createDiv();
  const app = { workspace: { containerEl: workspaceContainer } } as unknown as App;
  const store = createTestSettingsStore();
  store.updateDeviceSettings((settings) => ({ ...settings, motion: "full" }));
  const tab = new InkbookSettingTab(app, {} as Plugin, store);
  const controller = new InkbookSettingsModalController(app, tab, store);
  controller.open("settings");
  return { controller, store };
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

function transitionEnd(): Event {
  const event = new Event("transitionend", { bubbles: true });
  Object.defineProperty(event, "propertyName", { value: "block-size" });
  return event;
}
