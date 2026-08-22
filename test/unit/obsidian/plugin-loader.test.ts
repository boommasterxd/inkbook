import { describe, expect, it, vi } from "vitest";

import InkbookPluginLoader, {
  PluginRuntimeModuleLoader,
  pluginRuntimeHostModules,
  type PluginRuntimeModule,
  type PluginRuntimeWindow,
} from "../../../src/obsidian/plugin-loader";
import { activateInkbookPlugin } from "../../../src/obsidian/inkbook-plugin";
import { TestPlugin } from "../../fixtures/obsidian/test-plugin";

const HOST_MODULES_KEY = "__inkbookHostModules";

describe("plugin runtime loader", () => {
  it("provides every external module admitted by the runtime build", () => {
    expect(Object.keys(pluginRuntimeHostModules()).sort()).toEqual([
      "@codemirror/language",
      "@codemirror/state",
      "@codemirror/view",
      "obsidian",
    ]);
  });

  it("deduplicates parallel and later loads for one window", async () => {
    const imported = deferred<unknown>();
    const { ownerWindow, revokeObjectUrl } = runtimeWindow();
    const decode = vi.fn(async () => "export const runtime = true;");
    const importer = vi.fn(async () => imported.promise);
    const loader = new PluginRuntimeModuleLoader(importer, decode);

    const first = loader.load(ownerWindow);
    const second = loader.load(ownerWindow);
    await vi.waitFor(() => expect(importer).toHaveBeenCalledOnce());
    expect(hostModules(ownerWindow)).toEqual(pluginRuntimeHostModules());
    const runtime = runtimeModule();
    imported.resolve(runtime);

    await expect(first).resolves.toBe(runtime);
    await expect(second).resolves.toBe(runtime);
    await expect(loader.load(ownerWindow)).resolves.toBe(runtime);
    expect(decode).toHaveBeenCalledOnce();
    expect(importer).toHaveBeenCalledOnce();
    expect(hostModules(ownerWindow)).toBeUndefined();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:inkbook-runtime");
  });

  it("cleans temporary host modules and retries after an import failure", async () => {
    const { ownerWindow, revokeObjectUrl } = runtimeWindow();
    const runtime = runtimeModule();
    const importer = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("CSP rejected the module"))
      .mockResolvedValueOnce(runtime);
    const loader = new PluginRuntimeModuleLoader(importer, async () => "runtime");

    await expect(loader.load(ownerWindow)).rejects.toThrow("CSP rejected");
    expect(hostModules(ownerWindow)).toBeUndefined();
    await expect(loader.load(ownerWindow)).resolves.toBe(runtime);
    expect(importer).toHaveBeenCalledTimes(2);
    expect(revokeObjectUrl).toHaveBeenCalledTimes(2);
  });
});

describe("plugin loader lifecycle", () => {
  it("registers nothing when unload wins the settings-load race", async () => {
    const settings = deferred<unknown>();
    const plugin = new TestPlugin(pluginApp() as never, {} as never);
    vi.spyOn(plugin, "loadData").mockReturnValue(settings.promise);
    const registrationSpies = [
      vi.spyOn(plugin, "addCommand"),
      vi.spyOn(plugin, "addSettingTab"),
      vi.spyOn(plugin, "register"),
      vi.spyOn(plugin, "registerEditorExtension"),
      vi.spyOn(plugin, "registerEvent"),
      vi.spyOn(plugin, "registerMarkdownPostProcessor"),
    ];

    let active = true;
    const activation = activateInkbookPlugin(plugin, () => active);
    active = false;
    settings.resolve(undefined);
    await activation;

    for (const registration of registrationSpies) expect(registration).not.toHaveBeenCalled();
  });

  it("does not activate a runtime that resolves after unload", async () => {
    const loading = deferred<PluginRuntimeModule>();
    const activate = vi.fn(async () => vi.fn());
    const plugin = new InkbookPluginLoader(pluginApp() as never, {} as never, {
      load: async () => loading.promise,
    });

    const onload = plugin.onload();
    plugin.onunload();
    loading.resolve({ activateInkbookPlugin: activate });
    await onload;

    expect(activate).not.toHaveBeenCalled();
  });

  it("deactivates an activation that finishes after unload", async () => {
    const activation = deferred<() => void>();
    const deactivate = vi.fn();
    const activate = vi.fn(async () => activation.promise);
    const plugin = new InkbookPluginLoader(pluginApp() as never, {} as never, {
      load: async () => ({ activateInkbookPlugin: activate }),
    });

    const onload = plugin.onload();
    await vi.waitFor(() => expect(activate).toHaveBeenCalledOnce());
    plugin.onunload();
    activation.resolve(deactivate);
    await onload;

    expect(deactivate).toHaveBeenCalledOnce();
  });

  it("ignores an older load generation when the plugin reloads", async () => {
    const loading = deferred<PluginRuntimeModule>();
    const activate = vi.fn(async () => () => undefined);
    const plugin = new InkbookPluginLoader(pluginApp() as never, {} as never, {
      load: async () => loading.promise,
    });

    const firstLoad = plugin.onload();
    plugin.onunload();
    const secondLoad = plugin.onload();
    loading.resolve({ activateInkbookPlugin: activate });
    await Promise.all([firstLoad, secondLoad]);

    expect(activate).toHaveBeenCalledOnce();
  });
});

function runtimeModule(): PluginRuntimeModule {
  return { activateInkbookPlugin: async () => () => undefined };
}

function runtimeWindow(): {
  readonly ownerWindow: PluginRuntimeWindow;
  readonly revokeObjectUrl: ReturnType<typeof vi.fn>;
} {
  const revokeObjectUrl = vi.fn();
  return {
    ownerWindow: {
      Blob,
      DecompressionStream,
      Response,
      URL: {
        createObjectURL: vi.fn(() => "blob:inkbook-runtime"),
        revokeObjectURL: revokeObjectUrl,
      },
    },
    revokeObjectUrl,
  };
}

function hostModules(ownerWindow: PluginRuntimeWindow): unknown {
  return (ownerWindow as unknown as Record<string, unknown>)[HOST_MODULES_KEY];
}

function pluginApp(): object {
  return {
    loadLocalStorage: () => undefined,
    workspace: {
      containerEl: { ownerDocument: { defaultView: {} } },
    },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise = (_value: T): void => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      resolvePromise(value);
    },
  };
}
