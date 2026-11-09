/** Wiki names are literal; aliases and subpaths do not belong to the file path. */
export function linkpathFromWikiTarget(target: string): string {
  return target.split(/[|#]/u, 1)[0]?.trim() ?? "";
}

/** Decode Markdown destinations once while retaining literal percent signs in Wiki names. */
export function linkpathFromMarkdownTarget(target: string): string {
  const trimmed = target.trim();
  const path = trimmed.startsWith("<")
    ? trimmed.slice(1, trimmed.indexOf(">")).trim()
    : (trimmed.split(/\s+["']/u, 1)[0] ?? "");
  try {
    return decodeURIComponent(path.split("#", 1)[0] ?? "");
  } catch {
    return "";
  }
}
