// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";

import { Keymap, Modal, Platform, type App, type Plugin, type TFile } from "obsidian";
import { expect, it, vi } from "vitest";

import { InkImportAccess } from "../../../../src/obsidian/settings/import/import-access";
import { InkbookSettingTab } from "../../../../src/obsidian/settings/setting-tab";
import { InkbookSettingsModalController } from "../../../../src/obsidian/settings/settings-modal";
import { createAdaptivePanelFixture } from "../../../adapters/obsidian/adaptive-panel";
import { dialogButton } from "../../../fixtures/obsidian/dialog";
import { createTestSettingsStore } from "../../../fixtures/obsidian/settings-store";
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";
import { appliedImportFixture } from "../import/import-fixture";
import {
  disclosure,
  importDialogService,
  result,
  setupImportDialogTests,
} from "./ink-import-dialog-fixture";

setupImportDialogTests();

it.each(["desktop modal", "phone settings sheet"] as const)(
  "closes the owning %s before handing focus to the imported note",
  async (presentation) => {
    Platform.isPhone = presentation === "phone settings sheet";
    Platform.isMobile = Platform.isPhone;
    const sheet = Platform.isPhone
      ? createAdaptivePanelFixture("style", { motion: "reduced" })
      : undefined;
    const owner = new AbortController();
    const imported = await appliedImportFixture();
    const { path } = imported.journal.notes[0]!;
    const file = { path, extension: "md" } as TFile;
    const target = document.body.createEl("button", { text: path });
    const root = { win: window };
    const openFile = vi.fn().mockResolvedValue(undefined);
    const note = { getContainer: () => root, openFile };
    const setActiveLeaf = vi.fn(() => {
      expect(document.querySelector(".inkbook-settings-modal")).toBeNull();
      expect(document.querySelector(".inkbook-import-container")).toBeNull();
      target.focus();
    });
    const app = {
      keymap: new Keymap(),
      workspace: {
        containerEl: document.body,
        rootSplit: root,
        getMostRecentLeaf: () => note,
        setActiveLeaf,
      },
      vault: { getFileByPath: (requested: string) => (requested === path ? file : null) },
    } as unknown as App;
    const unrelatedModal = new Modal(app);
    const store = createTestSettingsStore();
    store.updateDeviceSettings((settings) => ({ ...settings, motion: "reduced" }));
    const service = importDialogService();
    service.apply.mockResolvedValueOnce({ ...result(), journal: imported.journal });
    const workScheduler = () => workSchedulerFromFrames(window);
    const access = new InkImportAccess({
      app,
      createService: () => service,
      localization: store.localization,
      readMotion: () => "reduced",
      signal: owner.signal,
      workScheduler,
    });
    const tab = new InkbookSettingTab(app, {} as Plugin, store, undefined, undefined, {
      inkImport: access,
      workScheduler,
    });
    const controller = new InkbookSettingsModalController(app, tab, store);
    try {
      unrelatedModal.open();
      controller.open("settings", sheet?.session.navigation);
      document.querySelector<HTMLElement>('[data-setting-name="Start import"]')!.click();
      await vi.waitFor(() =>
        expect(document.querySelector(".inkbook-import-container")).not.toBeNull(),
      );
      dialogButton("Scan vault").click();
      await expectImportStatus("Scan complete");
      dialogButton("Import handwriting").click();
      await expectImportStatus("Operation finished");
      disclosure("Notes to review (1)").click();
      dialogButton(`Open note (${path})`).click();
      await vi.waitFor(() => expect(document.activeElement).toBe(target));
      expect(openFile).toHaveBeenCalledExactlyOnceWith(file, { active: false });
      expect(setActiveLeaf).toHaveBeenCalledExactlyOnceWith(note, { focus: true });
      expect(unrelatedModal.containerEl.isConnected).toBe(true);
    } finally {
      owner.abort();
      controller.dispose();
      sheet?.session.close("immediate");
      unrelatedModal.close();
      Platform.isPhone = false;
      Platform.isMobile = false;
    }
  },
);

async function expectImportStatus(message: string): Promise<void> {
  await vi.waitFor(() =>
    expect(document.querySelector(".inkbook-import-status-message")?.textContent).toContain(
      message,
    ),
  );
}
