import { MARKDOWN_EMBED_LIMITS } from "./markdown-embed";
import { linkpathFromMarkdownTarget, linkpathFromWikiTarget } from "./markdown-link-target";

interface ReferenceCount {
  readonly complete: boolean;
  readonly references: number;
}

interface ReferenceResolution {
  readonly sourcePath: string;
  readonly targetPath: string;
  resolveLinkTarget(linkpath: string, sourcePath: string): { readonly path: string } | null;
}

function destinationEnd(text: string, from: number): number | undefined {
  let depth = 1;
  let angled = false;
  for (let index = from; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") return undefined;
    if (character === "<") angled = true;
    else if (character === ">") angled = false;
    else if (!angled && character === "(") depth += 1;
    else if (!angled && character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

/**
 * Includes ordinary links, inline/sized images and literals conservatively. Ambiguous
 * reference-style, escaped or HTML links keep the file rather than authorize trash.
 */
export function countMarkdownFileReferences(
  text: string,
  resolution: ReferenceResolution,
): ReferenceCount {
  if (text.length > MARKDOWN_EMBED_LIMITS.inputBytes) return { complete: false, references: 0 };
  let complete = !/^ {0,3}\[[^\]\n]+\]:/mu.test(text) && !/<(?:a|img|embed|object)\b/iu.test(text);
  let references = 0;
  let candidates = 0;
  const count = (linkpath: string) => {
    if (
      resolution.resolveLinkTarget(linkpath, resolution.sourcePath)?.path === resolution.targetPath
    )
      references += 1;
  };
  for (const match of text.matchAll(/\[\[([^\]\n]+)\]\]/gu)) {
    if (++candidates > MARKDOWN_EMBED_LIMITS.matches) return { complete: false, references };
    const target = match[1] ?? "";
    if (target.includes("\\")) complete = false;
    count(linkpathFromWikiTarget(target));
  }
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const marker = text.indexOf("](", searchFrom);
    if (marker < 0) break;
    const from = marker + 2;
    const to = destinationEnd(text, from);
    if (to === undefined || ++candidates > MARKDOWN_EMBED_LIMITS.matches)
      return { complete: false, references };
    const target = text.slice(from, to);
    const linkpath = linkpathFromMarkdownTarget(target);
    if (target.includes("\\") || /&(?:#\d+|#x[\da-f]+|[a-z]+);/iu.test(target) || !linkpath)
      complete = false;
    count(linkpath);
    searchFrom = to + 1;
  }
  return { complete, references };
}
