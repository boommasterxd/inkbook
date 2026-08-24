import { describe, expect, it, vi } from "vitest";

import {
  findEmbedsInVisibleRanges,
  MARKDOWN_EMBED_LIMITS,
  type ExecutableSyntaxIterator,
} from "../../../../src/obsidian/embeds";
import { executableSyntaxIn } from "../../../fixtures/obsidian/live-preview";

const RESOLVED_DOCUMENT = {
  documentId: "drawings/ink.svg",
  resourceUrl: "app://vault/ink.svg",
};

describe("Live Preview aggregate boundaries", () => {
  it("fails closed when split visible ranges exceed the aggregate UTF-8 budget", () => {
    const first = "a".repeat(MARKDOWN_EMBED_LIMITS.inputBytes / 2);
    const second = `${"b".repeat(MARKDOWN_EMBED_LIMITS.inputBytes / 2 - 1)}é`;
    const secondFrom = first.length + 1;
    const resolveDocument = vi.fn(() => RESOLVED_DOCUMENT);
    const iterateSyntax = vi.fn(() => true);

    expect(
      findEmbedsInVisibleRanges(
        (from) => (from === 0 ? first : second),
        [
          { from: 0, to: first.length },
          { from: secondFrom, to: secondFrom + second.length },
        ],
        "notes/note.md",
        resolveDocument,
        iterateSyntax,
      ),
    ).toEqual([]);
    expect(iterateSyntax).not.toHaveBeenCalled();
    expect(resolveDocument).not.toHaveBeenCalled();
  });

  it("fails closed without resolving partial targets above the aggregate match limit", () => {
    const embed = "!inkbook[[drawings/ink.svg]]";
    const first = Array.from({ length: MARKDOWN_EMBED_LIMITS.matches / 2 }, () => embed).join("\n");
    const second = Array.from({ length: MARKDOWN_EMBED_LIMITS.matches / 2 + 1 }, () => embed).join(
      "\n",
    );
    const text = `${first}\n${second}`;
    const secondFrom = first.length + 1;
    const resolveDocument = vi.fn(() => RESOLVED_DOCUMENT);

    expect(
      findEmbedsInVisibleRanges(
        (from, to) => text.slice(from, to),
        [
          { from: 0, to: first.length },
          { from: secondFrom, to: text.length },
        ],
        "notes/note.md",
        resolveDocument,
        executableSyntaxIn(text),
      ),
    ).toEqual([]);
    expect(resolveDocument).not.toHaveBeenCalled();
  });

  it("keeps below-limit split ranges synchronized with the current syntax and document state", () => {
    const first = "!inkbook[[drawings/ink.svg]]";
    const second = "!inkbook[Handwriting](drawings/ink.svg)";
    let text = `${first}\ngap\n${second}`;
    const secondFrom = text.indexOf(second);
    const ranges = [
      { from: 0, to: first.length },
      { from: secondFrom, to: text.length },
    ];
    const scan = (syntax: ExecutableSyntaxIterator) =>
      findEmbedsInVisibleRanges(
        (from, to) => text.slice(from, to),
        ranges,
        "notes/note.md",
        () => RESOLVED_DOCUMENT,
        syntax,
      );

    expect(scan(() => true)).toEqual([]);
    expect(scan(executableSyntaxIn(text)).map(({ from, to }) => text.slice(from, to))).toEqual([
      first,
      second,
    ]);

    text = `${"x".repeat(first.length)}\ngap\n${second}`;
    expect(scan(executableSyntaxIn(text)).map(({ from, to }) => text.slice(from, to))).toEqual([
      second,
    ]);
  });
});
