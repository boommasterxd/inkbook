import { linkpathFromMarkdownTarget, linkpathFromWikiTarget } from "./markdown-link-target";

export interface MarkdownInkbookEmbed {
  readonly description?: string;
  readonly from: number;
  readonly linkpath: string;
  readonly markdown: string;
  readonly to: number;
  readonly width?: number;
}

interface MarkdownSuppressedRange {
  readonly from: number;
  readonly to: number;
}

const WIKI_EMBED_PATTERN = /!\[\[([^\]\n]+)\]\]/gu;
const MARKDOWN_EMBED_PATTERN = /!\[(?<description>[^\]\n]*)\]\(([^)\n]+)\)/gu;
const AMBIGUOUS_MARKDOWN_DIMENSIONS =
  /(?:\\\||&#0*124;|&#x0*7c;|&(?:vert|verbar|VerticalLine);)\s*\d+(?:\s*x\s*\d+)?\s*$/iu;

export const MARKDOWN_EMBED_LIMITS = Object.freeze({
  inputBytes: 8 * 1024 * 1024,
  matches: 4096,
});

function isSvgLinkpath(linkpath: string): boolean {
  return linkpath.toLowerCase().endsWith(".svg");
}

function isStandaloneLine(text: string, from: number, to: number): boolean {
  const lineFrom = text.lastIndexOf("\n", from - 1) + 1;
  const followingNewline = text.indexOf("\n", to);
  const lineTo = followingNewline < 0 ? text.length : followingNewline;
  return /^ {0,3}$/u.test(text.slice(lineFrom, from)) && text.slice(to, lineTo).trim().length === 0;
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
  const trimmed = line.replace(/^ {0,3}/u, "");
  let length = 0;
  while (trimmed[length] === marker.character) length += 1;
  return length >= marker.length && trimmed.slice(length).trim().length === 0;
}

function fencedCodeEnd(
  text: string,
  opening: number,
  marker: NonNullable<ReturnType<typeof fenceMarker>>,
): number {
  const openingNewline = text.indexOf("\n", opening);
  if (openingNewline < 0) return text.length;
  let lineFrom = openingNewline + 1;
  while (lineFrom <= text.length) {
    const newline = text.indexOf("\n", lineFrom);
    const lineTo = newline < 0 ? text.length : newline;
    const line = text.slice(lineFrom, lineTo);
    if (isClosingFence(line, marker)) return newline < 0 ? text.length : newline + 1;
    if (newline < 0) break;
    lineFrom = newline + 1;
  }
  return text.length;
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

function frontmatterRanges(text: string): MarkdownSuppressedRange[] {
  const opening = /^\uFEFF?---\r?\n/u.exec(text);
  if (opening === null) return [];
  const closing = /^(?:---|\.\.\.)[ \t]*\r?$/gmu;
  closing.lastIndex = opening[0].length;
  const end = closing.exec(text);
  return [{ from: 0, to: end === null ? text.length : end.index + end[0].length }];
}

function inlineCodeEnd(text: string, from: number, delimiter: string): number | undefined {
  const tokens = /(?<boundary>\n[ \t]*\r?\n|^ {0,3}(?:`{3,}|~{3,}|<!--))|`+/gmu;
  tokens.lastIndex = from;
  for (let token = tokens.exec(text); token !== null; token = tokens.exec(text)) {
    if (token.groups?.["boundary"] !== undefined) return undefined;
    if (token[0].length === delimiter.length) return tokens.lastIndex;
  }
  return undefined;
}

function suppressedMarkdownRanges(text: string): readonly MarkdownSuppressedRange[] {
  const ranges = frontmatterRanges(text);
  const tokens = /^(?<fence> {0,3}(?:`{3,}|~{3,}))|<!--|`+/gmu;
  tokens.lastIndex = ranges[0]?.to ?? 0;
  for (let token = tokens.exec(text); token !== null; token = tokens.exec(text)) {
    const from = token.index;
    const marker = token.groups?.["fence"] === undefined ? null : fenceMarker(token[0]);
    let to: number;
    if (marker !== null) {
      to = fencedCodeEnd(text, from, marker);
    } else if (token[0] === "<!--") {
      const closing = text.indexOf("-->", tokens.lastIndex);
      to = closing < 0 ? text.length : closing + 3;
    } else {
      if (isEscaped(text, from)) continue;
      const closing = inlineCodeEnd(text, tokens.lastIndex, token[0]);
      if (closing === undefined) continue;
      to = closing;
    }
    ranges.push({ from, to });
    tokens.lastIndex = to;
  }
  return ranges;
}

function nativeCandidateAllowed(text: string, from: number, target: string) {
  const lineFrom = text.lastIndexOf("\n", from - 1) + 1;
  if (!/^ {0,3}$/u.test(text.slice(lineFrom, from))) return false;
  return !target.includes("#");
}

function nativeImagePresentation(
  description: string,
): { readonly description?: string; readonly width?: number } | undefined {
  const size = /(?:^|\|)\s*(\d+)(\s*x\s*\d+)?\s*$/iu.exec(description);
  if (size === null) return description ? { description } : {};
  const width = Number(size[1]);
  if (size[2] !== undefined || !Number.isSafeInteger(width) || width <= 0) return undefined;
  const label = description.slice(0, size.index).trim();
  return { width, ...(label ? { description: label } : {}) };
}

function nativeMarkdownTargetAllowed(target: string): boolean {
  const trimmed = target.trim();
  return /^<[^<>\r\n]+>$/u.test(trimmed) || /^[^\s<>"']+$/u.test(trimmed);
}

function allowedCandidate(text: string, match: RegExpMatchArray, target: string): boolean {
  if (!nativeCandidateAllowed(text, match.index ?? 0, target)) return false;
  return (
    match.groups === undefined ||
    (nativeMarkdownTargetAllowed(target) &&
      !AMBIGUOUS_MARKDOWN_DIMENSIONS.test(match.groups["description"] ?? ""))
  );
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
    const target = match.groups === undefined ? match[1] : match[2];
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
    const description = (match.groups?.description ?? target.split("|").slice(1).join("|")).trim();
    if (!allowedCandidate(text, match, target)) continue;
    const presentation = nativeImagePresentation(description);
    if (presentation === undefined) continue;
    matches.push({ from, linkpath, markdown, to, ...presentation });
  }
  return matches;
}

/** Retains native dimension spelling when an existing embed receives a new target. */
export function markdownInkbookEmbedDisplayText(embed: MarkdownInkbookEmbed): string | undefined {
  const opening = embed.markdown.indexOf("[");
  if (embed.markdown[opening + 1] === "[") {
    const separator = embed.markdown.indexOf("|", opening + 2);
    return separator < 0 ? undefined : embed.markdown.slice(separator + 1, -2);
  }
  const description = embed.markdown.slice(opening + 1, embed.markdown.indexOf("]("));
  return description || undefined;
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
