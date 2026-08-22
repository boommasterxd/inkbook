import type { FileManager } from "obsidian";

import {
  createInkbookFilename,
  findAvailableInkbookPath,
  type RandomBytesSource,
} from "../../persistence/documents/file-naming";
import { parentVaultPath, type ValidatedVaultPath } from "../../persistence/documents/vault-path";
import type { FilePlacementV1 } from "../../domain/settings/types";
import type { PathNormalizer } from "./boundary";
import type { ObsidianVaultFileAdapter } from "./file-adapter";
import { ObsidianVaultPathBoundary } from "./vault-path-boundary";

const MAXIMUM_ATTACHMENT_PATH_ATTEMPTS = 32;

export interface CreationPathResult {
  readonly fallback: "attachment-folder-unavailable" | "custom-folder-unavailable" | null;
  readonly path: ValidatedVaultPath;
}

export class ObsidianCreationPathResolver {
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

  async resolve(
    placement: FilePlacementV1,
    sourcePath: string,
    date: Date,
    random: RandomBytesSource,
  ): Promise<CreationPathResult> {
    const normalizedSource = this.#paths.normalizeSource(sourcePath);
    const noteFolder = normalizedSource === "" ? null : parentVaultPath(normalizedSource);

    if (placement.mode === "obsidian-attachment-folder") {
      try {
        return {
          fallback: null,
          path: await this.#availableAttachmentPath(normalizedSource, date, random),
        };
      } catch {
        return {
          fallback: "attachment-folder-unavailable",
          path: await this.#availablePath(noteFolder, date, random),
        };
      }
    }

    if (placement.mode === "custom-vault-folder") {
      const customFolder = this.#paths.availableFolder(placement.folder);
      if (customFolder !== null) {
        return {
          fallback: null,
          path: await this.#availablePath(customFolder, date, random),
        };
      }
      return {
        fallback: "custom-folder-unavailable",
        path: await this.#availablePath(noteFolder, date, random),
      };
    }

    return { fallback: null, path: await this.#availablePath(noteFolder, date, random) };
  }

  async #availablePath(
    folder: ValidatedVaultPath | null,
    date: Date,
    random: RandomBytesSource,
  ): Promise<ValidatedVaultPath> {
    return findAvailableInkbookPath(folder, date, random, {
      exists: (path) => this.#paths.exists(path),
    });
  }

  async #availableAttachmentPath(
    sourcePath: string,
    date: Date,
    random: RandomBytesSource,
  ): Promise<ValidatedVaultPath> {
    for (let attempt = 0; attempt < MAXIMUM_ATTACHMENT_PATH_ATTEMPTS; attempt += 1) {
      const filename = createInkbookFilename(date, random);
      const available = this.#paths.normalize(
        await this.#fileManager.getAvailablePathForAttachment(filename, sourcePath),
      );
      const basename = available.slice(available.lastIndexOf("/") + 1);
      if (basename === filename && !this.#paths.exists(available)) return available;
    }
    throw new Error("inkbook-attachment-path-collision-limit");
  }
}
