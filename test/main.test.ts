// @vitest-environment happy-dom

import { IDBFactory } from "fake-indexeddb";
import { MarkdownView, type App, type PluginManifest } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import InkbookPlugin from "../src/main";
import { PhaseZeroRuntime } from "../src/adapters/obsidian/phase-zero-runtime";
import {
  RESOURCE_BUDGET_V1,
  ResourceCoordinatorV1,
} from "../src/application/resource-coordinator";

const COMMAND_COUNT = 4;
const EVENT_COUNT = 2;

function createPlugin(vaultName: string): InkbookPlugin {
  return new InkbookPlugin(
    {
      vault: { getName: (): string => vaultName },
      workspace: {
        iterateAllLeaves: vi.fn(),
        on: vi.fn(() => ({})),
        onLayoutReady: vi.fn(),
      },
    } as unknown as App,
    { id: "inkbook" } as PluginManifest,
  );
}

describe("InkbookPlugin", () => {
  it("loads and unloads without starting product work during bootstrap", async () => {
    const onLayoutReady = vi.fn<(callback: () => void) => void>();
    const plugin = new InkbookPlugin(
      {
        vault: { getName: (): string => "test-vault" },
        workspace: {
          iterateAllLeaves: vi.fn(),
          on: vi.fn(() => ({})),
          onLayoutReady,
        },
      } as unknown as App,
      { id: "inkbook" } as PluginManifest,
    );

    await expect(plugin.onload()).resolves.toBeUndefined();
    expect(onLayoutReady).toHaveBeenCalledOnce();
    const registered = plugin as unknown as {
      readonly commands: readonly unknown[];
      readonly editorExtensions: readonly unknown[];
      readonly events: readonly unknown[];
      readonly postProcessors: readonly unknown[];
    };
    expect(registered.commands).toHaveLength(COMMAND_COUNT);
    expect(registered.editorExtensions).toHaveLength(1);
    expect(registered.events).toHaveLength(EVENT_COUNT);
    expect(registered.postProcessors).toHaveLength(1);
    expect(plugin.onunload()).toBeUndefined();
  });

  it("runs the lazy worker and IndexedDB environment command", async () => {
    const priorIndexedDb = globalThis.indexedDB;
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: new IDBFactory(),
    });
    const plugin = createPlugin("environment-vault");
    await plugin.onload();
    const commands = (
      plugin as unknown as {
        commands: {
          callback?: () => unknown;
          id: string;
        }[];
      }
    ).commands;
    const environment = commands.find(
      (command) => command.id === "phase-zero-run-environment-probe",
    );

    await environment?.callback?.();
    expect(environment).toBeDefined();

    plugin.onunload();
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: priorIndexedDb,
    });
  });

  it("releases the plugin-wide resource ledger after terminal disposal", async () => {
    const plugin = createPlugin("resource-vault");
    const resources = new ResourceCoordinatorV1(
      RESOURCE_BUDGET_V1.desktopOrAndroidTablet,
    );
    const runtime = new PhaseZeroRuntime(plugin, resources);

    runtime.register();
    runtime.dispose();
    await runtime.settle();

    expect(resources.snapshot()).toMatchObject({
      balanced: true,
      current: { bytes: 0, count: 0 },
      disposed: true,
      reserved: { bytes: 0, count: 0 },
    });
  });
});

describe("InkbookPlugin input probe", () => {
  it("shows the transient input probe without requiring recovery", async () => {
    const plugin = createPlugin("input-vault");
    await plugin.onload();
    const commands = (
      plugin as unknown as {
        commands: {
          editorCheckCallback?: (
            checking: boolean,
            editor: unknown,
            view: MarkdownView,
          ) => boolean;
          id: string;
        }[];
      }
    ).commands;
    const command = commands.find(
      (candidate) => candidate.id === "phase-zero-show-transient-input-probe",
    );
    const ViewConstructor = MarkdownView as unknown as new () => MarkdownView;
    const view = new ViewConstructor();
    Object.defineProperty(view, "file", {
      value: { path: "input-probe.md" },
    });

    expect(command?.editorCheckCallback?.(true, {}, view)).toBe(true);
    expect(command?.editorCheckCallback?.(false, {}, view)).toBe(true);
    expect(command).toBeDefined();
    plugin.onunload();
  });
});
