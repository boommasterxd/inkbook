import { normalizePath, type Plugin } from "obsidian";

import {
  createSidecarStoragePolicyStore,
  type SidecarStoragePolicyStoreV1,
} from "../../../application/persistence";
import type { PluginDataPortV1 } from "../../../application/persistence/types";

/** Keeps untrusted Obsidian plugin data behind the application data port. */
export class ObsidianPluginDataPortV1 implements PluginDataPortV1 {
  public constructor(private readonly plugin: Plugin) {}

  public loadData(): Promise<unknown> {
    return this.plugin.loadData();
  }

  public saveData(value: unknown): Promise<void> {
    return this.plugin.saveData(value);
  }
}

export function loadObsidianSidecarStoragePolicyV1(
  plugin: Plugin,
): Promise<SidecarStoragePolicyStoreV1> {
  return createSidecarStoragePolicyStore(new ObsidianPluginDataPortV1(plugin), {
    normalizePath,
  });
}
