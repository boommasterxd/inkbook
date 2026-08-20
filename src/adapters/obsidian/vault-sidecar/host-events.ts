import { TFile, TFolder, type Plugin } from "obsidian";

export type ObsidianVaultChangeV1 =
  | {
      readonly kind: "create" | "delete";
      readonly target: TFile | TFolder;
    }
  | { readonly kind: "modify"; readonly target: TFile }
  | {
      readonly kind: "rename";
      readonly target: TFile | TFolder;
      readonly oldPath: string;
    };

export interface ObsidianVaultChangeConsumerV1 {
  accept(change: ObsidianVaultChangeV1): void;
}

export function registerObsidianVaultChangesV1(
  plugin: Plugin,
  consumer: ObsidianVaultChangeConsumerV1,
): void {
  const vault = plugin.app.vault;
  plugin.registerEvent(
    vault.on("create", (target) => {
      if (target instanceof TFile || target instanceof TFolder) {
        consumer.accept(Object.freeze({ kind: "create", target }));
      }
    }),
  );
  plugin.registerEvent(
    vault.on("modify", (target) => {
      if (target instanceof TFile) {
        consumer.accept(Object.freeze({ kind: "modify", target }));
      }
    }),
  );
  registerRename(plugin, consumer);
  plugin.registerEvent(
    vault.on("delete", (target) => {
      if (target instanceof TFile || target instanceof TFolder) {
        consumer.accept(Object.freeze({ kind: "delete", target }));
      }
    }),
  );
}

export function registerObsidianVaultRenamesV1(
  plugin: Plugin,
  consumer: ObsidianVaultChangeConsumerV1,
): void {
  registerRename(plugin, consumer);
}

function registerRename(
  plugin: Plugin,
  consumer: ObsidianVaultChangeConsumerV1,
): void {
  plugin.registerEvent(
    plugin.app.vault.on("rename", (target, oldPath) => {
      if (target instanceof TFile || target instanceof TFolder) {
        consumer.accept(Object.freeze({ kind: "rename", oldPath, target }));
      }
    }),
  );
}
