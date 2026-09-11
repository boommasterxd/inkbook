// @vitest-environment happy-dom

import type { App, Plugin, SettingDefinition } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { confirmInkbookAction } from "../../../../src/obsidian/dialogs/action-dialog";
import { InkbookSettingTab } from "../../../../src/obsidian/settings/setting-tab";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { createTestSettingsStore } from "../../../fixtures/obsidian/settings-store";

vi.mock("../../../../src/obsidian/dialogs/action-dialog", () => ({
  confirmInkbookAction: vi.fn(),
}));

beforeEach(() => {
  installObsidianDomHelpers();
  document.body.replaceChildren();
  vi.mocked(confirmInkbookAction).mockReset();
});

function fixture() {
  const store = createTestSettingsStore();
  const createFolder = vi.fn(async () => undefined);
  const tab = new InkbookSettingTab({} as App, {} as Plugin, store, { createFolder });
  const element = document.body.createDiv();
  const general = tab.getSettingDefinitions()[0];
  if (general === undefined || !("items" in general)) throw new Error("Missing general group");
  const action = general.items?.find(
    (item) => "name" in item && item.name === "Create custom folder",
  ) as SettingDefinition;
  return { store, createFolder, element, activate: () => action.action?.(element, 0) };
}

describe("settings action confirmations", () => {
  it.each([false, true])(
    "creates the displayed folder only when confirmed: %s",
    async (confirmed) => {
      const harness = fixture();
      await harness.store.updateVaultSettings((settings) => ({
        ...settings,
        filePlacement: { mode: "custom-vault-folder", folder: "Drawings" },
      }));
      vi.mocked(confirmInkbookAction).mockResolvedValue(confirmed);
      harness.activate();
      await vi.waitFor(() => expect(confirmInkbookAction).toHaveBeenCalledOnce());
      expect(confirmInkbookAction).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          title: "Create custom folder?",
          description: "Create the vault folder “Drawings”?",
          confirmLabel: "Create folder",
        }),
      );
      expect(harness.createFolder).toHaveBeenCalledTimes(confirmed ? 1 : 0);
      if (confirmed) expect(harness.createFolder).toHaveBeenCalledWith("Drawings");
    },
  );

  it.each(["changed-folder", "closed-settings"])(
    "ignores stale confirmation: %s",
    async (reason) => {
      const harness = fixture();
      await harness.store.updateVaultSettings((settings) => ({
        ...settings,
        filePlacement: { mode: "custom-vault-folder", folder: "Drawings" },
      }));
      let finish: ((confirmed: boolean) => void) | undefined;
      vi.mocked(confirmInkbookAction).mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      harness.activate();
      if (reason === "closed-settings") harness.element.remove();
      else
        await harness.store.updateVaultSettings((settings) => ({
          ...settings,
          filePlacement: { mode: "custom-vault-folder", folder: "Other" },
        }));
      finish?.(true);
      await Promise.resolve();
      expect(harness.createFolder).not.toHaveBeenCalled();
    },
  );
});
