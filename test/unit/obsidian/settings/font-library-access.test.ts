// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";
import { Keymap, type App } from "obsidian";
import { expect, it, vi } from "vitest";
import { FontLibraryAccess } from "../../../../src/obsidian/settings/fonts/font-library-access";
import type { VaultFontLibrary } from "../../../../src/obsidian/fonts/vault-font-library";
import { installDialogTestLifecycle } from "../../../fixtures/obsidian/dialog";
import { createTestSettingsStore } from "../../../fixtures/obsidian/settings-store";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";

installDialogTestLifecycle();

function fixture() {
  const settings = createTestSettingsStore();
  settings.updateDeviceSettings((current) => ({ ...current, motion: "reduced" }));
  const lifetime = new AbortController();
  const trigger = document.body.createEl("button", { text: "Manage fonts" });
  const changed = vi.fn();
  const imported = vi.fn(async () => []);
  const id = "1".repeat(64);
  const prepareImport = vi.fn(async () => ({
    id,
    fileName: "Font.woff2",
    familyName: "Font",
    weight: 400,
    style: "normal",
    resource: {
      id,
      family: "upload",
      weight: 400,
      style: "normal",
      mimeType: "font/woff2",
      data: "AA==",
    },
  }));
  const access = new FontLibraryAccess({
    app: { keymap: new Keymap(), workspace: { containerEl: document.body } } as App,
    settings,
    library: {
      list: () => [],
      prepareImport,
      commitImport: imported,
      releasePrepared: vi.fn(),
    } as unknown as VaultFontLibrary,
    signal: lifetime.signal,
    workScheduler: () => new TestWorkScheduler(),
    onChanged: changed,
  });
  return { access, lifetime, trigger, changed, imported };
}

async function importFile(): Promise<void> {
  document.querySelector<HTMLButtonElement>('button[aria-label="Add font"]')!.click();
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    value: [{ name: "Font.woff2", size: 1, arrayBuffer: async () => new Uint8Array([1]).buffer }],
  });
  input.dispatchEvent(new Event("change"));
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Next"]')!.disabled).toBe(
      false,
    ),
  );
  document.querySelector<HTMLButtonElement>('button[aria-label="Next"]')!.click();
  document.querySelector<HTMLButtonElement>('button[aria-label="Next"]')!.click();
  document.querySelector<HTMLButtonElement>('button[aria-label="Add font"]')!.click();
}

function dismissDialog(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

it("owns one dialog, returns focus, and stops opening when the plugin is released", async () => {
  const context = fixture();
  context.access.open(context.trigger);
  context.access.open(context.trigger);
  expect(document.querySelectorAll(".inkbook-font-library-dialog")).toHaveLength(1);
  dismissDialog();
  await vi.waitFor(() => expect(document.querySelector(".inkbook-font-library-dialog")).toBeNull());
  expect(document.activeElement).toBe(context.trigger);
  expect(context.changed).not.toHaveBeenCalled();
  context.access.open(context.trigger);
  context.access.dispose();
  expect(document.querySelector(".inkbook-font-library-dialog")).toBeNull();
  context.lifetime.abort();
  context.access.open(context.trigger);
  expect(document.querySelector(".inkbook-font-library-dialog")).toBeNull();
});

it("refreshes callers after closing a changed library and after a late admitted import", async () => {
  const context = fixture();
  context.access.open(context.trigger);
  await importFile();
  await vi.waitFor(() =>
    expect(document.querySelector(".inkbook-font-library-success")?.textContent).toContain(
      "Font imported",
    ),
  );
  expect(context.changed).not.toHaveBeenCalled();
  dismissDialog();
  await vi.waitFor(() => expect(context.changed).toHaveBeenCalledOnce());
  let complete!: () => void;
  context.imported.mockImplementation(
    () =>
      new Promise<never[]>((resolve) => {
        complete = () => resolve([]);
      }),
  );
  context.access.open(context.trigger);
  await importFile();
  await vi.waitFor(() => expect(context.imported).toHaveBeenCalledTimes(2));
  dismissDialog();
  await vi.waitFor(() => expect(document.querySelector(".inkbook-font-library-dialog")).toBeNull());
  complete();
  await vi.waitFor(() => expect(context.changed).toHaveBeenCalledTimes(2));
  context.access.dispose();
});
