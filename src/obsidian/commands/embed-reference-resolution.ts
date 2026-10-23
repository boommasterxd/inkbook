import { findMarkdownInkbookEmbeds, type MarkdownInkbookEmbed } from "../embeds/markdown-embed";
import type {
  PresentationEmbedReference,
  ReadingViewEmbedReference,
} from "../embeds/presentation/presentation-port";
import type { ObsidianLinkAdapter } from "../vault/links";

export interface ResolvedEmbedRange {
  readonly from: number;
  readonly markdown: string;
  readonly to: number;
}

function findEmbedAt(
  embeds: readonly MarkdownInkbookEmbed[],
  range: Pick<ResolvedEmbedRange, "from" | "to">,
): MarkdownInkbookEmbed | undefined {
  let low = 0;
  let high = embeds.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = embeds[middle];
    if (candidate === undefined) return undefined;
    if (candidate.from < range.from) low = middle + 1;
    else if (candidate.from > range.from) high = middle - 1;
    else return candidate.to === range.to ? candidate : undefined;
  }
  return undefined;
}

function resolvesExpectedDocument(
  embed: MarkdownInkbookEmbed | undefined,
  reference: PresentationEmbedReference,
  links: ObsidianLinkAdapter,
): embed is MarkdownInkbookEmbed {
  if (embed === undefined) return false;
  return (
    links.resolveLinkTarget(embed.linkpath, reference.sourcePath)?.path === reference.documentId
  );
}

function validReadingIdentity(reference: ReadingViewEmbedReference): boolean {
  return (
    reference.section.text.length > 0 &&
    Number.isSafeInteger(reference.section.lineStart) &&
    reference.section.lineStart >= 0 &&
    Number.isSafeInteger(reference.section.lineEnd) &&
    reference.section.lineEnd >= reference.section.lineStart &&
    Number.isSafeInteger(reference.sectionFrom) &&
    reference.sectionFrom >= 0 &&
    Number.isSafeInteger(reference.sectionTo) &&
    reference.sectionTo > reference.sectionFrom &&
    reference.sectionTo <= reference.section.text.length &&
    reference.section.text.slice(reference.sectionFrom, reference.sectionTo) === reference.markdown
  );
}

function isSectionBoundary(text: string, from: number, to: number): boolean {
  const startsAtLineBoundary = from === 0 || text[from - 1] === "\n";
  const endsAtLineBoundary = text[to - 1] === "\n" || to === text.length || text[to] === "\n";
  return startsAtLineBoundary && endsAtLineBoundary;
}

function resolveReadingRange(
  text: string,
  reference: ReadingViewEmbedReference,
  links: ObsidianLinkAdapter,
): ResolvedEmbedRange | undefined {
  if (!validReadingIdentity(reference)) return undefined;
  const embeds = findMarkdownInkbookEmbeds(text);
  let resolved: ResolvedEmbedRange | undefined;
  let searchFrom = 0;
  while (searchFrom <= text.length) {
    const sectionFrom = text.indexOf(reference.section.text, searchFrom);
    if (sectionFrom < 0) break;
    const sectionTo = sectionFrom + reference.section.text.length;
    const range = {
      from: sectionFrom + reference.sectionFrom,
      markdown: reference.markdown,
      to: sectionFrom + reference.sectionTo,
    };
    if (
      isSectionBoundary(text, sectionFrom, sectionTo) &&
      text.slice(range.from, range.to) === reference.markdown &&
      resolvesExpectedDocument(findEmbedAt(embeds, range), reference, links)
    ) {
      if (resolved !== undefined) return undefined;
      resolved = range;
    }
    searchFrom = sectionFrom + 1;
  }
  return resolved;
}

export function resolvePresentationEmbedRange(
  text: string,
  reference: PresentationEmbedReference,
  links: ObsidianLinkAdapter,
): ResolvedEmbedRange | undefined {
  if (reference.kind === "reading-view") return resolveReadingRange(text, reference, links);
  const range = { from: reference.from, to: reference.to };
  const embed = findEmbedAt(findMarkdownInkbookEmbeds(text), range);
  return resolvesExpectedDocument(embed, reference, links) && embed !== undefined
    ? { ...range, markdown: embed.markdown }
    : undefined;
}
