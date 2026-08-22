import type { TFile } from "obsidian";

import type { ValidatedVaultPath } from "../../persistence/documents/vault-path";
import { normalizeSourcePath, normalizeVaultPath, type PathNormalizer } from "./boundary";
import type { ObsidianVaultFileAdapter } from "./file-adapter";

export class ObsidianVaultPathBoundary {
  readonly #files: ObsidianVaultFileAdapter;
  readonly #normalizePath: PathNormalizer;

  constructor(files: ObsidianVaultFileAdapter, normalizePath: PathNormalizer) {
    this.#files = files;
    this.#normalizePath = normalizePath;
  }

  normalize(path: string): ValidatedVaultPath {
    return normalizeVaultPath(path, this.#normalizePath);
  }

  normalizeSource(path: string): ValidatedVaultPath | "" {
    return normalizeSourcePath(path, this.#normalizePath);
  }

  resolveFile(path: string): TFile {
    return this.#files.resolveFile(path);
  }

  availableFolder(path: string): ValidatedVaultPath | null {
    try {
      const normalized = this.normalize(path);
      this.#files.resolveFolder(normalized);
      return normalized;
    } catch {
      return null;
    }
  }

  exists(path: ValidatedVaultPath): boolean {
    return this.#files.pathExists(path);
  }
}
