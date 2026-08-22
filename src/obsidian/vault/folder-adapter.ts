import type { TFolder, Vault } from "obsidian";

import { normalizeVaultPath, VaultBoundaryError, type PathNormalizer } from "./boundary";

type FolderConstructor = abstract new (...arguments_: never[]) => TFolder;

export class ObsidianVaultFolderAdapter {
  readonly #folderClass: FolderConstructor;
  readonly #normalizePath: PathNormalizer;
  readonly #vault: Vault;

  constructor(vault: Vault, folderClass: FolderConstructor, normalizePath: PathNormalizer) {
    this.#vault = vault;
    this.#folderClass = folderClass;
    this.#normalizePath = normalizePath;
  }

  async createFolder(path: string): Promise<void> {
    const normalized = normalizeVaultPath(path, this.#normalizePath);
    const existing = this.#vault.getFolderByPath(normalized);
    if (existing instanceof this.#folderClass) return;
    if (this.#vault.getAbstractFileByPath(normalized) !== null) {
      throw new VaultBoundaryError("unexpected-host-result");
    }
    await this.#vault.createFolder(normalized);
    if (!(this.#vault.getFolderByPath(normalized) instanceof this.#folderClass)) {
      throw new VaultBoundaryError("unexpected-host-result");
    }
  }
}
