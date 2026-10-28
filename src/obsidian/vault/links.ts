import type { FileManager, MetadataCache, TFile } from "obsidian";

import { normalizeSourcePath, normalizeVaultPath, type PathNormalizer } from "./boundary";
import type { ObsidianFileClasses, ObsidianVaultFileAdapter } from "./file-adapter";

type ReferenceKnowledge =
  { readonly state: "unresolved" } | { readonly state: "resolved"; readonly references: number };

export interface MetadataResolutionPort {
  isResolved(): boolean;
}

export interface CurrentSourceReferenceCount {
  readonly references: number;
  readonly sourcePath: string;
}

interface ObsidianSvgLinkResolution {
  readonly fileClass: ObsidianFileClasses["file"];
  readonly metadataCache: Pick<MetadataCache, "getFirstLinkpathDest">;
  readonly normalizePath: PathNormalizer;
  readonly resolveFile: (path: string) => TFile | null;
}

export function resolveObsidianSvgLink(
  linkpath: string,
  sourcePath: string,
  ports: ObsidianSvgLinkResolution,
): TFile | null {
  try {
    const path = linkpath.trim();
    if (path.length === 0 || path.includes("\0") || /^(?:[\\/]|[a-z][a-z\d+.-]*:)/iu.test(path)) {
      return null;
    }
    const source = normalizeSourcePath(sourcePath, ports.normalizePath);
    const file = ports.metadataCache.getFirstLinkpathDest(ports.normalizePath(path), source);
    if (!(file instanceof ports.fileClass) || !/\.svg$/iu.test(file.path)) return null;
    const normalized = normalizeVaultPath(file.path, ports.normalizePath);
    return normalized === file.path && ports.resolveFile(normalized) === file ? file : null;
  } catch {
    return null;
  }
}

function isCompleteMarkdownLink(value: string): boolean {
  if (value.includes("\n") || value.includes("\r")) return false;
  return (
    (value.startsWith("[[") && value.endsWith("]]")) ||
    (value.startsWith("[") && value.includes("](") && value.endsWith(")"))
  );
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
    const link = this.#fileManager.generateMarkdownLink(file, source);
    if (!isCompleteMarkdownLink(link)) {
      throw new Error("Obsidian generated an incomplete Markdown link.");
    }
    return `!inkbook${link}`;
  }

  resolveLinkTarget(linkpath: string, sourcePath: string): TFile | null {
    return resolveObsidianSvgLink(linkpath, sourcePath, {
      fileClass: this.#classes.file,
      metadataCache: this.#metadataCache,
      normalizePath: this.#normalizePath,
      resolveFile: (path) => this.#files.resolveFile(path),
    });
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
