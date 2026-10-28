// @vitest-environment happy-dom

import { SettingGroup, type App, type Plugin, type SettingDefinition } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { confirmInkbookAction } from "../../../../src/obsidian/dialogs/action-dialog";
import { InkbookSettingTab } from "../../../../src/obsidian/settings/setting-tab";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { createTestSettingsStore } from "../../../fixtures/obsidian/settings-store";

vi.mock("../../../../src/obsidian/dialogs/action-dialog", () => ({
  confirmInkbookAction: vi.fn(),
}));

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

beforeEach(() => {
  installObsidianDomHelpers();
  document.body.replaceChildren();
  vi.mocked(confirmInkbookAction).mockReset();
});

async function fixture() {
  const store = createTestSettingsStore();
  await store.updateVaultSettings((settings) => ({
    ...settings,
    filePlacement: { mode: "custom-vault-folder", folder: "Drawings" },
  }));
  const createFolder = vi.fn(async () => undefined);
  const tab = new InkbookSettingTab({} as App, {} as Plugin, store, { createFolder });
  const general = tab.getSettingDefinitions()[0];
  if (general === undefined || !("items" in general)) throw new Error("Missing general group");
  const action = general.items?.find(
    (item) => "name" in item && item.name === "Create custom folder",
  ) as SettingDefinition;
  const group = new SettingGroup(document.body);
  let element!: HTMLElement;
  group.addSetting((setting) => {
    element = setting.settingEl;
    setting.setName(action.name);
    const cleanup = action.render?.(setting, group);
    if (typeof cleanup === "function") cleanups.push(cleanup);
  });
  return { store, createFolder, element, activate: () => element.click() };
}

it.each([false, true])(
  "creates the displayed folder only when confirmed: %s",
  async (confirmed) => {
    const harness = await fixture();
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

it.each(["changed-folder", "closed-settings"])("ignores stale confirmation: %s", async (reason) => {
  const harness = await fixture();
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
});

it("reports a rejected folder creation without losing its action and permits keyboard retry", async () => {
  const harness = await fixture();
  vi.mocked(confirmInkbookAction).mockResolvedValue(true);
  harness.createFolder.mockRejectedValueOnce(new Error("Folder unavailable"));
  harness.element.focus();
  harness.activate();
  await vi.waitFor(() =>
    expect(harness.element.querySelector(".inkbook-settings-control-error")?.textContent).toBe(
      "The folder could not be created.",
    ),
  );
  const error = harness.element.querySelector<HTMLElement>(".inkbook-settings-control-error")!;
  expect(harness.element.getAttribute("aria-describedby")?.split(" ")).toContain(error.id);
  expect(error.getAttribute("aria-live")).toBe("polite");
  expect(document.activeElement).toBe(harness.element);
  expect(harness.createFolder).toHaveBeenCalledOnce();
  harness.element.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  await vi.waitFor(() => expect(harness.createFolder).toHaveBeenCalledTimes(2));
  expect(harness.createFolder).toHaveBeenLastCalledWith("Drawings");
  expect(error.hidden).toBe(true);
  expect(document.activeElement).toBe(harness.element);
});
