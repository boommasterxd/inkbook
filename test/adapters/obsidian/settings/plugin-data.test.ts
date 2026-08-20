import type { App, PluginManifest } from "obsidian";
import { describe, expect, it } from "vitest";

import InkbookPlugin from "../../../../src/main";
import {
  loadObsidianSidecarStoragePolicyV1,
  ObsidianPluginDataPortV1,
} from "../../../../src/adapters/obsidian/settings";

describe("Obsidian plugin data settings adapter", () => {
  it("loads and validates storage policy through the host normalizer", async () => {
    const plugin = new InkbookPlugin(
      {} as App,
      {
        id: "inkbook",
      } as PluginManifest,
    );
    (plugin as unknown as { loadedData: unknown }).loadedData = {
      policy: {
        mode: "vault-root",
        vaultRelativeRoot: "Annotations/Notes",
        version: 1,
      },
      revision: 4,
      version: 1,
    };

    const store = await loadObsidianSidecarStoragePolicyV1(plugin);

    expect(store.state.loadStatus).toBe("loaded");
    expect(store.snapshot).toMatchObject({
      policy: {
        mode: "vault-root",
        vaultRelativeRoot: "Annotations/Notes",
      },
      revision: 4,
    });
  });

  it("uses a truthful safe default after load failure", async () => {
    const plugin = new InkbookPlugin(
      {} as App,
      {
        id: "inkbook",
      } as PluginManifest,
    );
    plugin.loadData = (): Promise<unknown> =>
      Promise.reject(new Error("simulated load failure"));

    const store = await loadObsidianSidecarStoragePolicyV1(plugin);

    expect(store.snapshot.policy).toEqual({ version: 1, mode: "adjacent" });
    expect(store.state.loadStatus).toBe("defaulted-invalid");
    expect(store.canCreateSidecar).toBe(true);
  });

  it("requires saveData acknowledgement for durable policy state", async () => {
    const plugin = new InkbookPlugin(
      {} as App,
      {
        id: "inkbook",
      } as PluginManifest,
    );
    const port = new ObsidianPluginDataPortV1(plugin);

    await port.saveData({ version: 1 });

    expect((plugin as unknown as { savedData: unknown[] }).savedData).toEqual([
      { version: 1 },
    ]);
  });
});
