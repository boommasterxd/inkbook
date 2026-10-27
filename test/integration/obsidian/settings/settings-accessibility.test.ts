// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";

import type { App, Plugin } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { confirmInkbookAction } from "../../../../src/obsidian/dialogs/action-dialog";
import { InkbookSettingTab } from "../../../../src/obsidian/settings/setting-tab";
import { InkbookSettingsModalController } from "../../../../src/obsidian/settings/settings-modal";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { assertAccessibleSemantics } from "../../../fixtures/accessibility";
import { dialogButton } from "../../../fixtures/obsidian/dialog";
import { createTestSettingsStore } from "../../../fixtures/obsidian/settings-store";
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";

beforeEach(installObsidianDomHelpers);
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const app = (): App => ({ workspace: { containerEl: document.body } }) as App;

describe("settings and confirmation semantic accessibility gate", () => {
  it.each(["settings", "shortcuts"] as const)("scans the open %s view", async (view) => {
    const store = createTestSettingsStore();
    store.updateDeviceSettings((settings) => ({ ...settings, motion: "reduced" }));
    const tab = new InkbookSettingTab(app(), {} as Plugin, store, undefined, undefined, {
      workScheduler: () => workSchedulerFromFrames(window),
    });
    const controller = new InkbookSettingsModalController(app(), tab, store);
    try {
      controller.open(view);
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog).not.toBeNull();
      await assertAccessibleSemantics(dialog!, ["aria-dialog-name", "button-name"]);
      for (const trigger of dialog!.querySelectorAll<HTMLButtonElement>(
        '.inkbook-settings-tool-trigger[aria-expanded="false"]',
      ))
        trigger.click();
      await assertAccessibleSemantics(
        dialog!,
        view === "settings" ? ["label", "select-name", "button-name"] : ["button-name"],
      );
    } finally {
      controller.dispose();
    }
  });

  it("scans a destructive confirmation before cancelling through its public control", async () => {
    const result = confirmInkbookAction(app(), {
      title: "Delete embed?",
      description: "The SVG file will be kept.",
      confirmLabel: "Delete embed",
      destructive: true,
      readMotion: () => "reduced",
    });
    try {
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog).not.toBeNull();
      await assertAccessibleSemantics(dialog!, ["aria-dialog-name", "button-name"]);
    } finally {
      dialogButton("Cancel").click();
      await expect(result).resolves.toBe(false);
    }
  });
});
