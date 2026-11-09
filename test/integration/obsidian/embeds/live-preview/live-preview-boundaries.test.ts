import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";

import { LivePreviewBlocks } from "../../../../../src/obsidian/embeds/live-preview/live-preview-blocks";
import { LivePreviewEntrances } from "../../../../../src/obsidian/embeds/live-preview/live-preview-entrances";
import type { VisibleEmbed } from "../../../../../src/obsidian/embeds/live-preview/live-preview-widget";
import { MARKDOWN_EMBED_LIMITS } from "../../../../../src/obsidian/embeds/markdown-embed";
import type { EmbedIntegrationPorts } from "../../../../../src/obsidian/embeds/presentation/presentation-port";
import type { InkbookDocumentRecognition } from "../../../../../src/obsidian/embeds/preview/document-recognition";

function build(
  text: string,
  recognition: { value: InkbookDocumentRecognition | undefined } = { value: undefined },
) {
  const resolveDocument = vi.fn((documentId: string) => ({
    documentId,
    resourceUrl: `app://${documentId}`,
  }));
  const ports = {
    documents: { cached: () => recognition.value },
    resolveDocument,
  } as unknown as EmbedIntegrationPorts;
  const entrances = new LivePreviewEntrances("note.md");
  const blocks = LivePreviewBlocks.create(EditorState.create({ doc: text }), ports, entrances, {
    enabled: true,
    sourcePath: "note.md",
  });
  return { blocks, resolveDocument, ports, entrances };
}

describe("Live Preview candidate boundaries", () => {
  it("enhances native candidates only after validation and removes rejected replacements", () => {
    const recognition: { value: InkbookDocumentRecognition | undefined } = { value: undefined };
    const { blocks, ports, entrances } = build("![Drawing](a.svg)", recognition);
    expect(blocks.decorations.size).toBe(0);
    const visit = vi.fn();
    blocks.visitVisible([{ from: 0, to: 30 }], visit);
    expect(visit).toHaveBeenCalledOnce();
    recognition.value = {
      aspectRatio: 1,
      safeSvg: "<svg/>",
      contentIdentity: { revision: 1, outputHash: "a".repeat(64) },
    };
    const recognized = blocks.refresh(new Set(["a.svg"]), ports, entrances);
    expect(recognized.decorations.size).toBe(1);
    recognition.value = false;
    expect(recognized.refresh(new Set(["a.svg"]), ports, entrances).decorations.size).toBe(0);
  });
  it("fails closed before link resolution when the note exceeds the UTF-8 budget", () => {
    const text = `![[a.svg]]\n${"é".repeat(MARKDOWN_EMBED_LIMITS.inputBytes / 2)}`;
    const { blocks, resolveDocument } = build(text);
    expect(blocks.decorations.size).toBe(0);
    expect(resolveDocument).not.toHaveBeenCalled();
  });

  it("fails closed without resolving partial targets above the match limit", () => {
    const { blocks, resolveDocument } = build(
      Array.from({ length: MARKDOWN_EMBED_LIMITS.matches + 1 }, () => "![[a.svg]]").join("\n"),
    );
    expect(blocks.decorations.size).toBe(0);
    expect(resolveDocument).not.toHaveBeenCalled();
  });

  it("visits only fully visible occurrences of both supported link syntaxes", () => {
    const first = "![[a.svg]]";
    const second = "![Handwriting](b.svg)";
    const third = "![[a.svg]]";
    const text = `${first}\ngap\n${second}\ngap\n${third}`;
    const { blocks } = build(text);
    const visit = vi.fn<(embed: VisibleEmbed) => void>();
    blocks.visitVisible([{ from: first.length + 1, to: text.length }], visit);
    expect(visit.mock.calls.map(([embed]) => text.slice(embed.from, embed.to))).toEqual([
      second,
      third,
    ]);
    visit.mockClear();
    blocks.visitVisible([{ from: 1, to: first.length }], visit);
    expect(visit).not.toHaveBeenCalled();
  });

  it("deduplicates overlapping visibility ranges without combining partial block coverage", () => {
    const first = "![[a.svg]]";
    const second = "![Handwriting](b.svg)";
    const text = `${first}\n${second}`;
    const { blocks } = build(text);
    const visit = vi.fn<(embed: VisibleEmbed) => void>();
    blocks.visitVisible(
      [
        { from: first.length + 1, to: text.length },
        { from: 0, to: first.length },
        { from: first.length - 1, to: text.length },
        { from: 0, to: first.length },
      ],
      visit,
    );
    expect(visit.mock.calls.map(([embed]) => embed.resolved.documentId)).toEqual([
      "a.svg",
      "b.svg",
    ]);
    visit.mockClear();
    blocks.visitVisible(
      [
        { from: 0, to: first.length - 1 },
        { from: 1, to: first.length },
      ],
      visit,
    );
    expect(visit).not.toHaveBeenCalled();
  });
});
