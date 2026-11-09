import { afterEach, expect, it, vi } from "vitest";

import * as markdown from "../../../../src/obsidian/embeds/markdown-embed";
import {
  ReadingMarkdownIndex,
  READING_MARKDOWN_INDEX_LIMITS,
} from "../../../../src/obsidian/embeds/reading-markdown-index";
import { createReadingViewPostProcessor } from "../../../../src/obsidian/embeds/reading-view";
import { PresentationLifecycleRegistry } from "../../../../src/obsidian/embeds/presentation/presentation-lifecycle-registry";
import { ColorSchemeBroadcaster } from "../../../../src/obsidian/theme/color-scheme";
import { FakePresentationElement } from "../../../fixtures/obsidian/presentation-dom";
import { immediateWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";

afterEach(() => vi.restoreAllMocks());

function observeMarkdownWork() {
  const find = markdown.findMarkdownInkbookEmbeds;
  let candidateReads = 0;
  const parse = vi.spyOn(markdown, "findMarkdownInkbookEmbeds").mockImplementation((text) =>
    find(text).map((embed) => ({
      ...embed,
      get from() {
        candidateReads += 1;
        return embed.from;
      },
    })),
  );
  return { parse, candidateReads: () => candidateReads };
}

it("shares one full-note parse and line index across native hosts and asynchronous negative recognition", async () => {
  const count = 64;
  let text = Array.from({ length: count }, (_, index) => `![[drawing-${String(index)}.svg]]`).join(
    "\n",
  );
  const originalIndexOf = Object.getOwnPropertyDescriptor(String.prototype, "indexOf")?.value as (
    this: string,
    search: string,
    position?: number,
  ) => number;
  let lineBoundaryReads = 0;
  vi.spyOn(String.prototype, "indexOf").mockImplementation(function (
    this: string,
    search,
    position,
  ) {
    if (this === text && search === "\n") lineBoundaryReads += 1;
    return originalIndexOf.call(this, search, position);
  });
  const work = observeMarkdownWork();
  const lifecycle = new PresentationLifecycleRegistry();
  const listeners = new Set<() => void>();
  const recognize = vi.fn(async () => false as const);
  const subscribe = vi.fn((listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const processor = createReadingViewPostProcessor({
    documents: { cached: () => false, recognize, subscribe },
    lifecycle,
    resolveDocument: (linkpath) => ({
      documentId: linkpath,
      resourceUrl: `app://vault/${linkpath}`,
    }),
    scheme: new ColorSchemeBroadcaster({ getColorScheme: () => "light" }),
    sessions: { activate: vi.fn(), detach: vi.fn(), mount: vi.fn() },
    workScheduler: () => immediateWorkScheduler(),
  });
  const sections = Array.from({ length: count }, (_, line) => {
    const root = new FakePresentationElement(undefined, "p");
    const native = root.createEl("img");
    const getSectionInfo = vi.fn(() => ({ text, lineStart: line, lineEnd: line }));
    void processor(
      root as unknown as HTMLElement,
      {
        sourcePath: "notes/note.md",
        getSectionInfo,
        addChild: (child: { load(): void }) => child.load(),
      } as never,
    );
    return { root, native, getSectionInfo };
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(work.parse).toHaveBeenCalledOnce();
  expect(work.candidateReads()).toBeLessThanOrEqual(count * 2 * (Math.ceil(Math.log2(count)) + 3));
  expect(lineBoundaryReads).toBeLessThanOrEqual(4 * (count + 1));
  expect(recognize).toHaveBeenCalledTimes(count);
  for (const [line, section] of sections.entries()) {
    expect(section.getSectionInfo).toHaveBeenCalledTimes(2);
    expect(section.root.children).toEqual([section.native]);
    expect(subscribe).toHaveBeenNthCalledWith(
      line + 1,
      expect.any(Function),
      `drawing-${String(line)}.svg`,
    );
  }
  text += "\nAfter";
  for (const listener of listeners) listener();
  await Promise.resolve();
  await Promise.resolve();
  expect(work.parse).toHaveBeenCalledTimes(2);
  lifecycle.disposeAll();
  expect(listeners.size).toBe(0);
});

it("bounds actual candidate visits at full Markdown embed capacity", () => {
  const count = markdown.MARKDOWN_EMBED_LIMITS.matches;
  const text = Array.from(
    { length: count },
    (_, index) => `![[drawing-${String(index)}.svg]]`,
  ).join("\n");
  const work = observeMarkdownWork();
  const index = new ReadingMarkdownIndex();
  for (let line = 0; line < count; line += 1) {
    expect(
      index.standaloneEmbed("capacity.md", { text, lineStart: line, lineEnd: line })?.linkpath,
    ).toBe(`drawing-${String(line)}.svg`);
  }
  expect(work.parse).toHaveBeenCalledOnce();
  expect(work.candidateReads()).toBeLessThanOrEqual(count * (Math.ceil(Math.log2(count)) + 1));
});

it("evicts retained source bytes before the entry ceiling and never retains oversized input", () => {
  const parse = vi.spyOn(markdown, "findMarkdownInkbookEmbeds");
  const index = new ReadingMarkdownIndex();
  const text = "x".repeat(markdown.MARKDOWN_EMBED_LIMITS.inputBytes);
  const count = Math.floor(READING_MARKDOWN_INDEX_LIMITS.retainedBytes / (2 * text.length)) + 1;
  expect(count).toBeLessThan(READING_MARKDOWN_INDEX_LIMITS.entries);
  const section = { text, lineStart: 0, lineEnd: 0 };
  for (let path = 0; path < count; path += 1)
    expect(index.standaloneEmbed(`${String(path)}.md`, section)).toBeUndefined();
  index.standaloneEmbed(`${String(count - 1)}.md`, section);
  expect(parse).toHaveBeenCalledTimes(count);
  index.standaloneEmbed("0.md", section);
  expect(parse).toHaveBeenCalledTimes(count + 1);
  index.standaloneEmbed("0.md", { ...section, text: `${text}x` });
  index.standaloneEmbed("0.md", section);
  expect(parse).toHaveBeenCalledTimes(count + 1);
});
