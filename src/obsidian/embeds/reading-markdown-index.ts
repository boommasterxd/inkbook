import {
  findMarkdownInkbookEmbeds,
  MARKDOWN_EMBED_LIMITS,
  type MarkdownInkbookEmbed,
} from "./markdown-embed";

interface ReadingMarkdownSection {
  readonly lineEnd: number;
  readonly lineStart: number;
  readonly text: string;
}

interface IndexedReadingSource {
  readonly bytes: number;
  readonly embeds: readonly MarkdownInkbookEmbed[];
  readonly lineStarts: Uint32Array;
  readonly text: string;
}

export const READING_MARKDOWN_INDEX_LIMITS = Object.freeze({
  entries: 8,
  retainedBytes: 64 * 1024 * 1024,
});

function indexLineStarts(text: string): Uint32Array {
  let lines = 1;
  for (let offset = text.indexOf("\n"); offset >= 0; offset = text.indexOf("\n", offset + 1))
    lines += 1;
  const starts = new Uint32Array(lines);
  let line = 1;
  for (let offset = text.indexOf("\n"); offset >= 0; offset = text.indexOf("\n", offset + 1))
    starts[line++] = offset + 1;
  return starts;
}

function firstEmbedAtOrAfter(embeds: readonly MarkdownInkbookEmbed[], from: number): number {
  let low = 0;
  let high = embeds.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((embeds[middle]?.from ?? Infinity) < from) low = middle + 1;
    else high = middle;
  }
  return low;
}

function sourceIndex(text: string, sourcePath: string): IndexedReadingSource {
  const embeds = findMarkdownInkbookEmbeds(text);
  const lineStarts = embeds.length === 0 ? new Uint32Array(0) : indexLineStarts(text);
  const candidateBytes = embeds.reduce(
    (bytes, embed) =>
      bytes +
      64 +
      2 * (embed.markdown.length + embed.linkpath.length + (embed.description?.length ?? 0)),
    0,
  );
  return {
    bytes: 2 * (text.length + sourcePath.length) + lineStarts.byteLength + candidateBytes,
    embeds,
    lineStarts,
    text,
  };
}

/** One bounded current-source index per path, shared by one plugin's Reading postprocessor. */
export class ReadingMarkdownIndex {
  readonly #sources = new Map<string, IndexedReadingSource>();
  #retainedBytes = 0;

  clear(): void {
    this.#sources.clear();
    this.#retainedBytes = 0;
  }

  standaloneEmbed(
    sourcePath: string,
    section: ReadingMarkdownSection,
  ): MarkdownInkbookEmbed | undefined {
    if (
      !Number.isSafeInteger(section.lineStart) ||
      section.lineStart < 0 ||
      !Number.isSafeInteger(section.lineEnd) ||
      section.lineEnd < section.lineStart ||
      section.text.length > MARKDOWN_EMBED_LIMITS.inputBytes
    )
      return undefined;
    const index = this.#currentSource(sourcePath, section.text);
    const from = index.lineStarts[section.lineStart];
    const nextLine = index.lineStarts[section.lineEnd + 1];
    if (from === undefined || section.lineEnd >= index.lineStarts.length) return undefined;
    const to = nextLine === undefined ? section.text.length : nextLine - 1;
    const position = firstEmbedAtOrAfter(index.embeds, from);
    const embed = index.embeds[position];
    if (embed === undefined || embed.to > to) return undefined;
    const following = index.embeds[position + 1];
    if (following !== undefined && following.to <= to) return undefined;
    return section.text.slice(from, to).trim() === embed.markdown ? embed : undefined;
  }

  #currentSource(sourcePath: string, text: string): IndexedReadingSource {
    const previous = this.#sources.get(sourcePath);
    this.#sources.delete(sourcePath);
    if (previous?.text === text) {
      this.#sources.set(sourcePath, previous);
      return previous;
    }
    this.#retainedBytes -= previous?.bytes ?? 0;
    const current = sourceIndex(text, sourcePath);
    while (
      this.#sources.size >= READING_MARKDOWN_INDEX_LIMITS.entries ||
      this.#retainedBytes + current.bytes > READING_MARKDOWN_INDEX_LIMITS.retainedBytes
    ) {
      const oldest = this.#sources.entries().next().value;
      if (oldest === undefined) return current;
      this.#sources.delete(oldest[0]);
      this.#retainedBytes -= oldest[1].bytes;
    }
    this.#sources.set(sourcePath, current);
    this.#retainedBytes += current.bytes;
    return current;
  }
}
