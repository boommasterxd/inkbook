import { normalizePath, TFile, type App } from "obsidian";

import type { ResolvedInkbookDocument } from "./presentation-port";

function decodeLinkpath(linkpath: string): string | undefined {
  try {
    return decodeURIComponent(linkpath);
  } catch {
    return undefined;
  }
}

function isSafeVaultLinkpath(linkpath: string): boolean {
  const withoutFragment = linkpath.split("#", 1)[0]?.trim() ?? "";
  const decoded = decodeLinkpath(withoutFragment);
  if (
    decoded === undefined ||
    decoded.length === 0 ||
    decoded.startsWith("/") ||
    decoded.startsWith("\\") ||
    /^[a-z][a-z\d+.-]*:/iu.test(decoded)
  ) {
    return false;
  }
  const segments = decoded.replaceAll("\\", "/").split("/");
  return !segments.some((segment) => segment === ".." || segment === ".");
}

export function createObsidianDocumentResolver(
  app: App,
): (linkpath: string, sourcePath: string) => ResolvedInkbookDocument | undefined {
  return (linkpath, sourcePath) => {
    if (!isSafeVaultLinkpath(linkpath)) {
      return undefined;
    }
    const targetPath = linkpath.split("#", 1)[0]?.trim();
    if (targetPath === undefined) {
      return undefined;
    }
    const target = app.metadataCache.getFirstLinkpathDest(targetPath, normalizePath(sourcePath));
    if (!(target instanceof TFile) || target.extension.toLowerCase() !== "svg") {
      return undefined;
    }
    return {
      documentId: normalizePath(target.path),
      resourceUrl: app.vault.getResourcePath(target),
    };
  };
}
