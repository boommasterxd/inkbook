import type { FileManager, MetadataCache, TFile } from "obsidian";

import type { ReferenceKnowledge } from "../../persistence/documents/reference-decision";
import { normalizeSourcePath, normalizeVaultPath, type PathNormalizer } from "./boundary";
import type { ObsidianFileClasses, ObsidianVaultFileAdapter } from "./file-adapter";

export interface MetadataResolutionPort {
  isResolved(): boolean;
}

export interface CurrentSourceReferenceCount {
  readonly references: number;
  readonly sourcePath: string;
}

export class ObsidianLinkAdapter {
  readonly #classes: ObsidianFileClasses;
  readonly #fileManager: FileManager;
  readonly #files: ObsidianVaultFileAdapter;
  readonly #metadataCache: MetadataCache;
  readonly #normalizePath: PathNormalizer;
  readonly #resolution: MetadataResolutionPort;

  constructor(options: {
    readonly classes: ObsidianFileClasses;
    readonly fileManager: FileManager;
    readonly files: ObsidianVaultFileAdapter;
    readonly metadataCache: MetadataCache;
    readonly normalizePath: PathNormalizer;
    readonly resolution: MetadataResolutionPort;
  }) {
    this.#classes = options.classes;
    this.#fileManager = options.fileManager;
    this.#files = options.files;
    this.#metadataCache = options.metadataCache;
    this.#normalizePath = options.normalizePath;
    this.#resolution = options.resolution;
  }

  generateEmbed(filePath: string, sourcePath: string): string {
    const file = this.#files.resolveFile(filePath);
    const source = normalizeSourcePath(sourcePath, this.#normalizePath);
    return `!${this.#fileManager.generateMarkdownLink(file, source, undefined, "")}`;
  }

  resolveLinkTarget(linkpath: string, sourcePath: string): TFile | null {
    let normalizedLinkpath: string;
    try {
      normalizedLinkpath = normalizeVaultPath(linkpath, this.#normalizePath);
    } catch {
      return null;
    }
    const source = normalizeSourcePath(sourcePath, this.#normalizePath);
    const file = this.#metadataCache.getFirstLinkpathDest(normalizedLinkpath, source);
    return file instanceof this.#classes.file ? file : null;
  }

  referenceKnowledge(
    filePath: string,
    currentSource?: CurrentSourceReferenceCount,
  ): ReferenceKnowledge {
    if (!this.#resolution.isResolved()) {
      return { state: "unresolved" };
    }
    let target: string;
    try {
      target = normalizeVaultPath(filePath, this.#normalizePath);
      this.#files.resolveFile(target);
    } catch {
      return { state: "unresolved" };
    }

    let normalizedSource: string | undefined;
    let references = 0;
    if (currentSource !== undefined) {
      if (!Number.isSafeInteger(currentSource.references) || currentSource.references < 0) {
        return { state: "unresolved" };
      }
      normalizedSource = normalizeSourcePath(currentSource.sourcePath, this.#normalizePath);
      references = currentSource.references;
    }
    for (const [sourcePath, destinations] of Object.entries(this.#metadataCache.resolvedLinks)) {
      if (sourcePath === normalizedSource) continue;
      const count = destinations[target];
      if (count === undefined) continue;
      if (!Number.isSafeInteger(count) || count < 0) {
        return { state: "unresolved" };
      }
      references += count;
      if (!Number.isSafeInteger(references)) {
        return { state: "unresolved" };
      }
    }
    return { state: "resolved", references };
  }
}
