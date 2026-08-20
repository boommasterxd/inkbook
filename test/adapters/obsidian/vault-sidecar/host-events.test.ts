import {
  TFile,
  TFolder,
  type App,
  type PluginManifest,
  type Vault,
} from "obsidian";
import { describe, expect, it, vi } from "vitest";

import InkbookPlugin from "../../../../src/main";
import { registerObsidianVaultChangesV1 } from "../../../../src/adapters/obsidian/vault-sidecar/host-events";

type VaultEventName = "create" | "delete" | "modify" | "rename";

describe("Obsidian Vault event boundary", () => {
  it("registers owned host events and narrows files and folders", () => {
    const callbacks = new Map<VaultEventName, (...values: unknown[]) => void>();
    const vault = {
      on: vi.fn(
        (name: VaultEventName, callback: (...values: unknown[]) => void) => {
          callbacks.set(name, callback);
          return { name };
        },
      ),
    } as unknown as Vault;
    const plugin = new InkbookPlugin(
      { vault } as App,
      { id: "inkbook" } as PluginManifest,
    );
    const accepted: unknown[] = [];

    registerObsidianVaultChangesV1(plugin, {
      accept: (change): void => {
        accepted.push(change);
      },
    });
    callbacks.get("create")?.(hostFile("Notes/A.md"));
    callbacks.get("modify")?.(hostFolder("Notes"));
    callbacks.get("rename")?.(hostFolder("Archive"), "Notes");
    callbacks.get("delete")?.({ path: "confused" });

    expect(
      (plugin as unknown as { readonly events: readonly unknown[] }).events,
    ).toHaveLength(Number("4"));
    expect(accepted).toMatchObject([
      { kind: "create", target: { path: "Notes/A.md" } },
      { kind: "rename", oldPath: "Notes", target: { path: "Archive" } },
    ]);
  });
});

function hostFile(path: string): TFile {
  return hostPath(TFile.prototype, path) as TFile;
}

function hostFolder(path: string): TFolder {
  return hostPath(TFolder.prototype, path) as TFolder;
}

function hostPath(prototype: object, path: string): object {
  const target = Object.create(prototype) as object;
  Object.defineProperty(target, "path", { value: path });
  return target;
}
