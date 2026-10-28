import { normalizePath, TFile, type App } from "obsidian";

import { resolveObsidianSvgLink } from "../vault/links";
import type { ResolvedInkbookDocument } from "./presentation/presentation-port";

export function createObsidianDocumentResolver(
  app: App,
): (linkpath: string, sourcePath: string) => ResolvedInkbookDocument | undefined {
  return (linkpath, sourcePath) => {
    const target = resolveObsidianSvgLink(linkpath, sourcePath, {
      fileClass: TFile,
      metadataCache: app.metadataCache,
      normalizePath,
      resolveFile: (path) => app.vault.getFileByPath(path),
    });
    if (target === null) {
      return undefined;
    }
    return {
      documentId: normalizePath(target.path),
      resourceUrl: app.vault.getResourcePath(target),
    };
  };
}
