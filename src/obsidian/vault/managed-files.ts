import type { FileManager } from "obsidian";

import type { PathNormalizer } from "./boundary";
import type { ObsidianVaultFileAdapter } from "./file-adapter";
import { ObsidianVaultPathBoundary } from "./vault-path-boundary";

export class ObsidianManagedFileAdapter {
  readonly #fileManager: FileManager;
  readonly #paths: ObsidianVaultPathBoundary;

  constructor(
    fileManager: FileManager,
    files: ObsidianVaultFileAdapter,
    normalizePath: PathNormalizer,
  ) {
    this.#fileManager = fileManager;
    this.#paths = new ObsidianVaultPathBoundary(files, normalizePath);
  }

  async rename(filePath: string, newPath: string): Promise<void> {
    const file = this.#paths.resolveFile(filePath);
    const normalizedNewPath = this.#paths.normalize(newPath);
    await this.#fileManager.renameFile(file, normalizedNewPath);
    this.#paths.resolveFile(normalizedNewPath);
  }

  async trash(filePath: string): Promise<void> {
    await this.#fileManager.trashFile(this.#paths.resolveFile(filePath));
  }
}
