// @vitest-environment happy-dom

import "fake-indexeddb/auto";

import { Notice, TFile, type App, type PluginManifest } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import InkbookPlugin from "../src/main";

const REPEATED_LOAD_CYCLES = 3;
const ACKNOWLEDGED_VAULT_ID = "0123456789abcdef0123456789abcdef";
const VAULT_EVENT_NAMES = ["create", "modify", "rename", "delete"] as const;
const EXPECTED_VAULT_ID_READS = 2;
const EXPECTED_CONFORMANCE_OPENS = 2;
const ORPHAN_CANDIDATE_LIMIT = 10_000;
const CONTINUATION_FIXTURE_LENGTH = ORPHAN_CANDIDATE_LIMIT + 1;
const LAST_TWO_NOTICES = -2;

interface RegisteredCommand {
  readonly callback?: () => unknown;
  readonly id: string;
  readonly name: string;
}

interface PluginRegistrations {
  readonly commands: readonly RegisteredCommand[];
  readonly editorExtensions: readonly unknown[];
  readonly events: readonly unknown[];
  readonly postProcessors: readonly unknown[];
}

interface PluginHarness {
  readonly onLayoutReady: ReturnType<typeof vi.fn>;
  readonly plugin: InkbookPlugin;
  runLayoutReady(): void;
}

interface MaintenanceHarness {
  readonly getFiles: ReturnType<typeof vi.fn>;
  readonly pluginHarness: PluginHarness;
}

function createPlugin(
  app: Readonly<Record<string, unknown>> = {},
): PluginHarness {
  let layoutReady: (() => void) | undefined;
  const onLayoutReady = vi.fn((callback: () => void): void => {
    layoutReady = callback;
  });
  const plugin = new InkbookPlugin(
    { ...app, workspace: { onLayoutReady } } as unknown as App,
    { id: "inkbook" } as PluginManifest,
  );
  return {
    onLayoutReady,
    plugin,
    runLayoutReady: (): void => layoutReady?.(),
  };
}

function registrations(plugin: InkbookPlugin): PluginRegistrations {
  return plugin as unknown as PluginRegistrations;
}

function noticeMessages(): string[] {
  return (Notice as unknown as { readonly messages: string[] }).messages;
}

function vaultFile(path: string): TFile {
  const file = new TFile();
  file.path = path;
  return file;
}

function registeredCommand(
  plugin: InkbookPlugin,
  id: string,
): RegisteredCommand {
  const command = registrations(plugin).commands.find(
    (candidate) => candidate.id === id,
  );
  if (command === undefined)
    throw new Error(`Command ${id} was not registered.`);
  return command;
}

function createMaintenanceHarness(files: TFile[]): MaintenanceHarness {
  const getFiles = vi.fn(() => files);
  const vault = {
    getFiles,
    on: vi.fn((event: string) => ({ kind: event })),
  };
  return {
    getFiles,
    pluginHarness: createPlugin({
      loadLocalStorage: (): string => ACKNOWLEDGED_VAULT_ID,
      saveLocalStorage: (): void => undefined,
      vault,
    }),
  };
}

async function startRuntime(harness: PluginHarness): Promise<void> {
  await harness.plugin.onload();
  harness.runLayoutReady();
  await vi.waitFor(() => {
    expect(registrations(harness.plugin).events).toHaveLength(
      VAULT_EVENT_NAMES.length,
    );
  });
}

async function invokeSidecarReview(plugin: InkbookPlugin): Promise<void> {
  const callback = registeredCommand(
    plugin,
    "review-sidecar-candidates",
  ).callback;
  await callback?.();
}

beforeEach(() => {
  noticeMessages().splice(0);
});

describe("InkbookPlugin startup composition", () => {
  it("keeps onload bounded to settings and lightweight registrations", async () => {
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const indexedDbOpen = vi.spyOn(globalThis.indexedDB, "open");
    const harness = createPlugin();

    await expect(harness.plugin.onload()).resolves.toBeUndefined();
    await expect(harness.plugin.onload()).resolves.toBeUndefined();

    expect(registrations(harness.plugin)).toMatchObject({
      commands: [
        {
          id: "review-sidecar-candidates",
          name: "Review sidecar candidates",
        },
      ],
      editorExtensions: [],
      events: [],
      postProcessors: [],
    });
    expect(harness.onLayoutReady).toHaveBeenCalledTimes(1);
    expect(indexedDbOpen).not.toHaveBeenCalled();
    expect(noticeMessages()).toEqual([]);
    expect(timeout).not.toHaveBeenCalled();
  });

  it("defers Vault identity and recovery access until layout readiness", async () => {
    const indexedDbOpen = vi.spyOn(globalThis.indexedDB, "open");
    const loadLocalStorage = vi.fn((): null => null);
    const saveLocalStorage = vi.fn();
    const harness = createPlugin({ loadLocalStorage, saveLocalStorage });

    await harness.plugin.onload();

    expect(loadLocalStorage).not.toHaveBeenCalled();
    expect(saveLocalStorage).not.toHaveBeenCalled();
    expect(indexedDbOpen).not.toHaveBeenCalled();

    harness.runLayoutReady();
    await vi.waitFor(() => {
      expect(registrations(harness.plugin).editorExtensions).toHaveLength(1);
    });

    expect(loadLocalStorage).toHaveBeenCalledTimes(EXPECTED_VAULT_ID_READS);
    expect(saveLocalStorage).toHaveBeenCalledTimes(1);
    expect(indexedDbOpen).not.toHaveBeenCalled();
  });

  it(
    "opens one Vault-scoped recovery store after layout readiness",
    assertVaultScopedRuntime,
  );
});

describe("InkbookPlugin maintenance composition", () => {
  it("runs the registered bounded sidecar review through the runtime", async () => {
    const sidecars = [
      vaultFile("Notes/first.inkbook.json"),
      vaultFile("Notes/second.inkbook.json"),
      vaultFile("Notes/note.md"),
    ];
    const { getFiles, pluginHarness } = createMaintenanceHarness(sidecars);
    await startRuntime(pluginHarness);
    await invokeSidecarReview(pluginHarness.plugin);

    expect(getFiles).toHaveBeenCalledTimes(1);
    expect(noticeMessages()).toEqual([
      "Reviewed 3 Vault files and found 2 sidecar candidates.",
    ]);
    pluginHarness.plugin.onunload();
  });

  it("continues only when the maintenance command is invoked again", async () => {
    const candidate = vaultFile("Notes/repeated.inkbook.json");
    const sidecars = Array.from(
      { length: CONTINUATION_FIXTURE_LENGTH },
      () => candidate,
    );
    const { getFiles, pluginHarness } = createMaintenanceHarness(sidecars);
    await startRuntime(pluginHarness);

    await invokeSidecarReview(pluginHarness.plugin);
    expect(getFiles).toHaveBeenCalledTimes(1);
    await invokeSidecarReview(pluginHarness.plugin);
    await invokeSidecarReview(pluginHarness.plugin);

    expect(getFiles).toHaveBeenCalledTimes(REPEATED_LOAD_CYCLES);
    expect(noticeMessages()).toEqual([
      "Reviewed 10000 Vault files and found 10000 sidecar candidates. The candidate limit was reached; run the command again to continue.",
      "Reviewed 1 Vault file and found 1 sidecar candidate.",
      "Reviewed 10000 Vault files and found 10000 sidecar candidates. The candidate limit was reached; run the command again to continue.",
    ]);
    pluginHarness.plugin.onunload();
  });

  it("resets a stale continuation and reports the changed candidate set", async () => {
    const candidate = vaultFile("Notes/repeated.inkbook.json");
    const sidecars = Array.from(
      { length: CONTINUATION_FIXTURE_LENGTH },
      () => candidate,
    );
    const { pluginHarness } = createMaintenanceHarness(sidecars);
    await startRuntime(pluginHarness);

    await invokeSidecarReview(pluginHarness.plugin);
    sidecars.pop();
    await invokeSidecarReview(pluginHarness.plugin);
    sidecars.splice(
      0,
      sidecars.length,
      vaultFile("Notes/current.inkbook.json"),
    );
    await invokeSidecarReview(pluginHarness.plugin);

    expect(noticeMessages().slice(LAST_TWO_NOTICES)).toEqual([
      "Sidecar candidates changed; start a new review.",
      "Reviewed 1 Vault file and found 1 sidecar candidate.",
    ]);
    pluginHarness.plugin.onunload();
  });
});

describe("InkbookPlugin lifecycle composition", () => {
  it("does not register runtime consumers after unload during settings load", async () => {
    let acknowledgeLoad: ((value: unknown) => void) | undefined;
    const harness = createPlugin();
    harness.plugin.loadData = (): Promise<unknown> =>
      new Promise((resolve) => {
        acknowledgeLoad = resolve;
      });

    const loading = harness.plugin.onload();
    harness.plugin.onunload();
    acknowledgeLoad?.(null);
    await loading;

    expect(registrations(harness.plugin).commands).toHaveLength(0);
    expect(registrations(harness.plugin).editorExtensions).toHaveLength(0);
    expect(harness.onLayoutReady).not.toHaveBeenCalled();
  });

  it("invalidates a queued layout callback before it can open recovery", async () => {
    const indexedDbOpen = vi.spyOn(globalThis.indexedDB, "open");
    const harness = createPlugin({
      loadLocalStorage: (): string => ACKNOWLEDGED_VAULT_ID,
      saveLocalStorage: (): void => undefined,
    });
    await harness.plugin.onload();

    harness.plugin.onunload();
    harness.runLayoutReady();

    expect(indexedDbOpen).not.toHaveBeenCalled();
    expect(registrations(harness.plugin).editorExtensions).toHaveLength(0);
    expect(registrations(harness.plugin).events).toHaveLength(0);
  });

  it("unloads idempotently across independent layout-ready cycles", async () => {
    for (let cycle = 0; cycle < REPEATED_LOAD_CYCLES; cycle += 1) {
      const harness = createPlugin();
      await harness.plugin.onload();
      harness.runLayoutReady();
      await vi.waitFor(() => {
        expect(registrations(harness.plugin).editorExtensions).toHaveLength(1);
      });

      expect(harness.plugin.onunload()).toBeUndefined();
      expect(harness.plugin.onunload()).toBeUndefined();
    }

    expect(noticeMessages()).toEqual([]);
  });
});

async function assertVaultScopedRuntime(): Promise<void> {
  const indexedDbOpen = vi.spyOn(globalThis.indexedDB, "open");
  const vault = {
    getFiles: vi.fn(() => []),
    on: vi.fn((event: string) => ({ kind: event })),
  };
  const harness = createPlugin({
    loadLocalStorage: (): string => ACKNOWLEDGED_VAULT_ID,
    saveLocalStorage: (): void => undefined,
    vault,
  });

  await expect(harness.plugin.onload()).resolves.toBeUndefined();
  expect(indexedDbOpen).not.toHaveBeenCalled();
  expect(registrations(harness.plugin).events).toHaveLength(0);

  harness.runLayoutReady();
  await vi.waitFor(() => {
    expect(registrations(harness.plugin).events).toHaveLength(
      VAULT_EVENT_NAMES.length,
    );
  });

  expect(indexedDbOpen).toHaveBeenCalledTimes(EXPECTED_CONFORMANCE_OPENS);
  expect(vault.on.mock.calls.map(([event]) => event)).toEqual(
    VAULT_EVENT_NAMES,
  );
  harness.plugin.onunload();
}
