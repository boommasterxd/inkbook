import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";

import { LivePreviewBlocks } from "../../../../../src/obsidian/embeds/live-preview/live-preview-blocks";
import { LivePreviewEntrances } from "../../../../../src/obsidian/embeds/live-preview/live-preview-entrances";
import type { VisibleEmbed } from "../../../../../src/obsidian/embeds/live-preview/live-preview-widget";
import { MARKDOWN_EMBED_LIMITS } from "../../../../../src/obsidian/embeds/markdown-embed";
import type { EmbedIntegrationPorts } from "../../../../../src/obsidian/embeds/presentation/presentation-port";

function build(text: string) {
  const resolveDocument = vi.fn((documentId: string) => ({
    documentId,
    resourceUrl: `app://${documentId}`,
  }));
  const ports = {
    documents: { cached: () => undefined },
    resolveDocument,
  } as unknown as EmbedIntegrationPorts;
  const blocks = LivePreviewBlocks.create(
    EditorState.create({ doc: text }),
    ports,
    new LivePreviewEntrances("note.md"),
    { enabled: true, sourcePath: "note.md" },
  );
  return { blocks, resolveDocument };
}

describe("Live Preview candidate boundaries", () => {
  it("fails closed before link resolution when the note exceeds the UTF-8 budget", () => {
    const text = `!inkbook[[a.svg]]\n${"é".repeat(MARKDOWN_EMBED_LIMITS.inputBytes / 2)}`;
    const { blocks, resolveDocument } = build(text);
    expect(blocks.decorations.size).toBe(0);
    expect(resolveDocument).not.toHaveBeenCalled();
  });

  it("fails closed without resolving partial targets above the match limit", () => {
    const { blocks, resolveDocument } = build(
      Array.from({ length: MARKDOWN_EMBED_LIMITS.matches + 1 }, () => "!inkbook[[a.svg]]").join(
        "\n",
      ),
    );
    expect(blocks.decorations.size).toBe(0);
    expect(resolveDocument).not.toHaveBeenCalled();
  });

  it("visits only fully visible occurrences of both supported link syntaxes", () => {
    const first = "!inkbook[[a.svg]]";
    const second = "!inkbook[Handwriting](b.svg)";
    const third = "!inkbook[[a.svg]]";
    const text = `${first}\ngap\n${second}\ngap\n${third}`;
    const { blocks } = build(text);
    const visit = vi.fn<(embed: VisibleEmbed) => void>();
    blocks.visitVisible([{ from: first.length + 1, to: text.length }], visit);
    expect(visit.mock.calls.map(([embed]) => text.slice(embed.from, embed.to))).toEqual([
      third,
      second,
    ]);
    visit.mockClear();
    blocks.visitVisible([{ from: 1, to: first.length }], visit);
    expect(visit).not.toHaveBeenCalled();
  });
});
