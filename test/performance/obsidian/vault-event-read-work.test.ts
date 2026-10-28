// @vitest-environment happy-dom

import { TFile, TFolder } from "obsidian";
import { expect, it, vi } from "vitest";

import { createBuiltInSettings } from "../../../src/domain/settings";
import { activateInkbookPlugin } from "../../../src/obsidian/inkbook-plugin";
import { installObsidianDomHelpers } from "../../adapters/obsidian/dom";
import { TestPlugin } from "../../fixtures/obsidian/test-plugin";
import { createVaultEvents } from "../../fixtures/obsidian/vault-events";
import { observedSchedulingWindow } from "../../fixtures/obsidian/window-scheduling";

const File = TFile as unknown as new (path: string, size?: number) => TFile;
const Folder = TFolder as unknown as new (path: string) => TFolder;

async function vaultEventHarness(files: readonly TFile[]) {
  installObsidianDomHelpers();
  const scheduling = observedSchedulingWindow();
  const events = createVaultEvents();
  const ready: Array<() => void> = [];
  const byPath = new Map(files.map((file) => [file.path, file]));
  const read = vi.fn(async (_file: TFile) => "<svg/>");
  const getFileByPath = vi.fn((path: string) => byPath.get(path) ?? null);
  const plugin = new TestPlugin(
    {
      isDarkMode: () => false,
      loadLocalStorage: () => undefined,
      saveLocalStorage: () => undefined,
      metadataCache: { on: events.on.bind(events), resolvedLinks: {} },
      vault: { on: events.on.bind(events), read, getFileByPath },
      workspace: {
        containerEl: scheduling.root,
        getActiveViewOfType: () => null,
        on: events.on.bind(events),
        onLayoutReady: (callback: () => void) => ready.push(callback),
      },
    } as never,
    {} as never,
  );
  Object.assign(plugin, {
    settingsData: { ...createBuiltInSettings(), refreshRatePreference: 120 },
  });
  plugin.load();
  const deactivate = await activateInkbookPlugin(plugin);
  for (const callback of ready) callback();
  return {
    ...scheduling,
    events,
    read,
    getFileByPath,
    dispose: async () => {
      deactivate?.();
      plugin.unload();
      // Session shutdown releases the owning scheduler after its persistence drain.
      await Promise.resolve();
    },
  };
}

it("does zero Vault reads, lookups, or scheduled work for ordinary note and attachment events", async () => {
  const files = Array.from({ length: 1_000 }, (_, index) =>
    ["md", "png", "pdf"].map(
      (extension) => new File(`vault/${String(index)}.${extension}`, 1024 * 1024),
    ),
  ).flat();
  const harness = await vaultEventHarness(files);
  try {
    for (const file of [...files, new Folder("vault/folder")]) {
      harness.events.emit("create", file);
      harness.events.emit("modify", file);
    }
    harness.host.frame();
    await Promise.resolve();
    expect(harness.read).not.toHaveBeenCalled();
    expect(harness.getFileByPath).not.toHaveBeenCalled();
    expect(harness.host.frameRequests).toBe(0);
    expect(harness.host.timerRequests).toBe(0);
  } finally {
    await harness.dispose();
  }
  expect(harness.events.listenerCount()).toBe(0);
  expect(harness.host.pendingFrames).toBe(0);
  expect(harness.host.pendingTimers).toBe(0);
});

it("retains coalesced SVG classification with either extension case and releases pending work on unload", async () => {
  const files = [new File("drawing.svg", 6), new File("external.SVG", 6)];
  const harness = await vaultEventHarness(files);
  try {
    for (const file of files) {
      harness.events.emit("create", file);
      harness.events.emit("modify", file);
    }
    expect(harness.read).not.toHaveBeenCalled();
    harness.host.frame();
    await vi.waitFor(() => expect(harness.read).toHaveBeenCalledTimes(files.length));
    for (const file of files) expect(harness.read).toHaveBeenCalledWith(file);
    harness.events.emit("modify", files[0]!);
  } finally {
    await harness.dispose();
  }
  harness.host.frame();
  for (const file of files) harness.events.emit("modify", file);
  await Promise.resolve();
  expect(harness.read).toHaveBeenCalledTimes(files.length);
  expect(harness.events.listenerCount()).toBe(0);
  expect(harness.host.pendingFrames).toBe(0);
  expect(harness.host.pendingTimers).toBe(0);
});
