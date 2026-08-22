export interface MarkdownInkbookEmbed {
  readonly from: number;
  readonly linkpath: string;
  readonly markdown: string;
  readonly to: number;
}

interface MarkdownSuppressedRange {
  readonly from: number;
  readonly to: number;
}

const WIKI_EMBED_PATTERN = /!inkbook\[\[([^\]\n]+)\]\]/gu;
const MARKDOWN_EMBED_PATTERN = /!inkbook\[[^\]\n]*\]\(([^)\n]+)\)/gu;

export const MARKDOWN_EMBED_LIMITS = Object.freeze({
  inputBytes: 8 * 1024 * 1024,
  matches: 4096,
});

function linkpathFromWikiTarget(target: string): string {
  return target.split("|", 1)[0]?.trim() ?? "";
}

function linkpathFromMarkdownTarget(target: string): string {
  const trimmed = target.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed.split(/\s+["']/u, 1)[0] ?? "";
}

function isSvgLinkpath(linkpath: string): boolean {
  const pathWithoutFragment = linkpath.split("#", 1)[0] ?? "";
  return pathWithoutFragment.toLowerCase().endsWith(".svg");
}

function isStandaloneLine(text: string, from: number, to: number): boolean {
  const lineFrom = text.lastIndexOf("\n", from - 1) + 1;
  const followingNewline = text.indexOf("\n", to);
  const lineTo = followingNewline < 0 ? text.length : followingNewline;
  return (
    text.slice(lineFrom, from).trim().length === 0 && text.slice(to, lineTo).trim().length === 0
  );
}

function isWithinUtf8Limit(text: string, maximumBytes: number): boolean {
  let byteLength = 0;
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      byteLength += 1;
    } else if (codeUnit <= 0x7ff) {
      byteLength += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        byteLength += 4;
        index += 1;
      } else {
        byteLength += 3;
      }
    } else {
      byteLength += 3;
    }
    if (byteLength > maximumBytes) return false;
  }
  return true;
}

function isEscaped(text: string, position: number): boolean {
  let backslashes = 0;
  for (let index = position - 1; index >= 0 && text[index] === "\\"; index -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function collectHtmlCommentRanges(text: string): MarkdownSuppressedRange[] {
  const ranges: MarkdownSuppressedRange[] = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const from = text.indexOf("<!--", searchFrom);
    if (from < 0) break;
    const closing = text.indexOf("-->", from + 4);
    const to = closing < 0 ? text.length : closing + 3;
    ranges.push({ from, to });
    searchFrom = to;
  }
  return ranges;
}

function fenceMarker(
  line: string,
): { readonly character: "`" | "~"; readonly length: number } | null {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
  const marker = match?.[1];
  if (marker === undefined) return null;
  return { character: marker[0] as "`" | "~", length: marker.length };
}

function isClosingFence(
  line: string,
  marker: { readonly character: "`" | "~"; readonly length: number },
): boolean {
  const trimmed = line.startsWith("   ") ? line.slice(3) : line.trimStart();
  let length = 0;
  while (trimmed[length] === marker.character) length += 1;
  return length >= marker.length && trimmed.slice(length).trim().length === 0;
}

function collectFencedCodeRanges(text: string): MarkdownSuppressedRange[] {
  const ranges: MarkdownSuppressedRange[] = [];
  let active: { readonly from: number; readonly marker: ReturnType<typeof fenceMarker> } | null =
    null;
  let lineFrom = 0;
  while (lineFrom <= text.length) {
    const newline = text.indexOf("\n", lineFrom);
    const lineTo = newline < 0 ? text.length : newline;
    const line = text.slice(lineFrom, lineTo);
    if (active === null) {
      const marker = fenceMarker(line);
      if (marker !== null) active = { from: lineFrom, marker };
    } else if (active.marker !== null && isClosingFence(line, active.marker)) {
      ranges.push({ from: active.from, to: newline < 0 ? text.length : newline + 1 });
      active = null;
    }
    if (newline < 0) break;
    lineFrom = newline + 1;
  }
  if (active !== null) ranges.push({ from: active.from, to: text.length });
  return ranges;
}

function mergeRanges(ranges: MarkdownSuppressedRange[]): MarkdownSuppressedRange[] {
  const ordered = [...ranges].sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: MarkdownSuppressedRange[] = [];
  for (const range of ordered) {
    const previous = merged[merged.length - 1];
    if (previous === undefined || range.from > previous.to) {
      merged.push(range);
    } else if (range.to > previous.to) {
      merged[merged.length - 1] = { from: previous.from, to: range.to };
    }
  }
  return merged;
}

function rangeContains(ranges: readonly MarkdownSuppressedRange[], position: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const range = ranges[middle];
    if (range === undefined) return false;
    if (position < range.from) high = middle - 1;
    else if (position >= range.to) low = middle + 1;
    else return true;
  }
  return false;
}

function collectInlineCodeRanges(
  text: string,
  blockRanges: readonly MarkdownSuppressedRange[],
): MarkdownSuppressedRange[] {
  const ranges: MarkdownSuppressedRange[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "`" || isEscaped(text, index) || rangeContains(blockRanges, index)) {
      index += 1;
      continue;
    }
    let markerLength = 1;
    while (text[index + markerLength] === "`") markerLength += 1;
    const marker = "`".repeat(markerLength);
    const closing = text.indexOf(marker, index + markerLength);
    if (closing < 0) {
      index += markerLength;
      continue;
    }
    ranges.push({ from: index, to: closing + markerLength });
    index = closing + markerLength;
  }
  return ranges;
}

function suppressedMarkdownRanges(text: string): readonly MarkdownSuppressedRange[] {
  const blockRanges = mergeRanges([
    ...collectHtmlCommentRanges(text),
    ...collectFencedCodeRanges(text),
  ]);
  return mergeRanges([...blockRanges, ...collectInlineCodeRanges(text, blockRanges)]);
}

function collectMatches(
  text: string,
  pattern: RegExp,
  toLinkpath: (target: string) => string,
  maximumMatches: number,
  suppressedRanges: readonly MarkdownSuppressedRange[],
): MarkdownInkbookEmbed[] | undefined {
  const matches: MarkdownInkbookEmbed[] = [];
  let candidateCount = 0;
  for (const match of text.matchAll(pattern)) {
    if (candidateCount >= maximumMatches) return undefined;
    candidateCount += 1;
    const markdown = match[0];
    const target = match[1];
    const from = match.index;
    if (markdown === undefined || target === undefined || from === undefined) {
      continue;
    }
    if (isEscaped(text, from) || rangeContains(suppressedRanges, from)) continue;
    const linkpath = toLinkpath(target);
    const to = from + markdown.length;
    if (linkpath.length === 0 || !isSvgLinkpath(linkpath) || !isStandaloneLine(text, from, to)) {
      continue;
    }
    matches.push({ from, linkpath, markdown, to });
  }
  return matches;
}

export function findMarkdownInkbookEmbeds(text: string): readonly MarkdownInkbookEmbed[] {
  if (!isWithinUtf8Limit(text, MARKDOWN_EMBED_LIMITS.inputBytes)) return [];
  const suppressedRanges = suppressedMarkdownRanges(text);
  const wikiMatches = collectMatches(
    text,
    WIKI_EMBED_PATTERN,
    linkpathFromWikiTarget,
    MARKDOWN_EMBED_LIMITS.matches,
    suppressedRanges,
  );
  if (wikiMatches === undefined) return [];
  const markdownMatches = collectMatches(
    text,
    MARKDOWN_EMBED_PATTERN,
    linkpathFromMarkdownTarget,
    MARKDOWN_EMBED_LIMITS.matches - wikiMatches.length,
    suppressedRanges,
  );
  if (markdownMatches === undefined) return [];
  return [...wikiMatches, ...markdownMatches].sort(
    (left, right) => left.from - right.from || left.to - right.to,
  );
}
