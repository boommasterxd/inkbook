import { describe, expect, it } from "vitest";
import {
  findMarkdownInkbookEmbeds,
  MARKDOWN_EMBED_LIMITS,
  markdownInkbookEmbedDisplayText,
} from "../../../../src/obsidian/embeds/markdown-embed";

describe("Markdown Inkbook embeds", () => {
  it("returns mixed standalone forms in source order with exact ranges", () => {
    const lines = [
      "Before",
      "  ![[old.svg|Old]]  ",
      "![[folder/new.svg|New]]",
      "![A drawing](<folder/my page.svg>)",
    ];
    const text = lines.join("\n");
    const expected = [
      {
        markdown: "![[old.svg|Old]]",
        linkpath: "old.svg",
        description: "Old",
      },
      {
        markdown: "![[folder/new.svg|New]]",
        linkpath: "folder/new.svg",
        description: "New",
      },
      {
        markdown: "![A drawing](<folder/my page.svg>)",
        linkpath: "folder/my page.svg",
        description: "A drawing",
      },
    ];
    expect(findMarkdownInkbookEmbeds(text)).toEqual(
      expected.map((embed) => ({
        ...embed,
        from: text.indexOf(embed.markdown),
        to: text.indexOf(embed.markdown) + embed.markdown.length,
      })),
    );
  });

  it("leaves native embeds with unsupported image semantics to Obsidian", () => {
    const text = [
      "![[drawing.svg#section]]",
      "![Drawing](drawing.svg#section)",
      '![Drawing](drawing.svg "Title")',
      "![[drawing.svg|100x200]]",
      "![100x200](drawing.svg)",
      "![[drawing.svg|400 x 200]]",
      "![400x 200](drawing.svg)",
      "![[drawing.svg|400 x200]]",
      "![A drawing|400 x 200](drawing.svg)",
      "![[drawing.svg|0]]",
      "![9007199254740992](drawing.svg)",
      "Before ![[drawing.svg]] after",
      "![[notes.md]]",
      "![[accepted.svg]]",
    ].join("\n");
    expect(findMarkdownInkbookEmbeds(text).map((embed) => embed.markdown)).toEqual([
      "![[accepted.svg]]",
    ]);
  });
});

describe("Native image width", () => {
  it("leaves escaped and entity-encoded dimension separators to the native Markdown renderer", () => {
    const source = [
      "![A&#124;400](drawing.svg)",
      String.raw`![A\|400](drawing.svg)`,
      "![A&#x7c;400 x 200](drawing.svg)",
      "![A&vert;400](drawing.svg)",
      "![A &amp; B](drawing.svg)",
      "![A&#124;B](drawing.svg)",
    ].join("\n");
    expect(findMarkdownInkbookEmbeds(source).map((embed) => embed.markdown)).toEqual([
      "![A &amp; B](drawing.svg)",
      "![A&#124;B](drawing.svg)",
    ]);
  });

  it("keeps positive native widths separate from author descriptions and preserves their spelling", () => {
    const markdown = [
      "![[drawing.svg|00400]]",
      "![400](drawing.svg)",
      "![[drawing.svg|A drawing|400]]",
      "![A drawing|00400](drawing.svg)",
    ];
    const embeds = findMarkdownInkbookEmbeds(markdown.join("\n"));
    expect(embeds.map(({ width, description }) => ({ width, description }))).toEqual([
      { width: 400, description: undefined },
      { width: 400, description: undefined },
      { width: 400, description: "A drawing" },
      { width: 400, description: "A drawing" },
    ]);
    expect(embeds.map(markdownInkbookEmbedDisplayText)).toEqual([
      "00400",
      "400",
      "A drawing|400",
      "A drawing|00400",
    ]);
  });
});

describe("Markdown suppression", () => {
  it("does not consume a fence opener after an unmatched inline backtick", () => {
    const text = [
      "Unclosed `",
      "",
      "```md",
      "``",
      "![[hidden.svg]]",
      "![Hidden](hidden.svg)",
      "```",
      "![[accepted.svg]]",
    ].join("\n");
    expect(findMarkdownInkbookEmbeds(text).map((embed) => embed.linkpath)).toEqual([
      "accepted.svg",
    ]);
  });

  it.each([
    ["fenced code", "```md\n``\n![[hidden.svg]]\n```"],
    ["an HTML comment", "<!-- `\n![[hidden.svg]]\n-->"],
  ])("preserves %s boundaries without a preceding blank line", (_context, block) => {
    const text = `Unclosed \`\n${block}\n![[accepted.svg]]`;
    expect(findMarkdownInkbookEmbeds(text).map((embed) => embed.linkpath)).toEqual([
      "accepted.svg",
    ]);
  });

  it("keeps multiline inline code within its paragraph and matches complete backtick runs", () => {
    const text = [
      "Text `code with `` literal backticks",
      "![[inline.svg]]",
      "continued`",
      "",
      "Unclosed `",
      "",
      "![[accepted.svg]]",
      "Text `",
    ].join("\n");
    expect(findMarkdownInkbookEmbeds(text).map((embed) => embed.linkpath)).toEqual([
      "accepted.svg",
    ]);
  });

  it("ignores native embeds in frontmatter, code, comments, and escaped text", () => {
    const text = [
      "---",
      "image: |",
      "  ![[frontmatter.svg]]",
      "---",
      "```md",
      "![[fenced.svg]]",
      "```",
      "    ![[indented.svg]]",
      "`![[inline.svg]]`",
      "<!--",
      "![[comment.svg]]",
      "-->",
      String.raw`\![[escaped.svg]]`,
      "![[accepted.svg]]",
    ].join("\n");
    expect(findMarkdownInkbookEmbeds(text).map((embed) => embed.linkpath)).toEqual([
      "accepted.svg",
    ]);
  });

  it.each([
    ["a fence with a tab-indented closing marker", "```md\n\t```\n![[inside.svg]]\n```"],
    ["inline code", "`<!--`"],
    ["multi-backtick inline code", "Text ```<!--```"],
    ["fenced code", "```html\n<!--\n```"],
    ["frontmatter", "---\ncomment: <!--\n---"],
    ["comment containing a code fence", "<!--\n```\n-->"],
  ])("recognizes only subsequent embeds after %s", (_context, prefix) => {
    const text = `${prefix}\n![[accepted.svg]]`;
    expect(findMarkdownInkbookEmbeds(text).map((embed) => embed.linkpath)).toEqual([
      "accepted.svg",
    ]);
  });

  it("suppresses unclosed comments and fences through the end of the note", () => {
    for (const opening of ["<!--", "~~~md", "```"]) {
      expect(findMarkdownInkbookEmbeds(`${opening}\n![[hidden.svg]]`)).toEqual([]);
    }
  });

  it("closes fences indented by up to three spaces without interpreting their contents", () => {
    expect(
      findMarkdownInkbookEmbeds("  ~~~md\n<!--\n   ~~~\n![[visible.svg]]").map(
        (embed) => embed.linkpath,
      ),
    ).toEqual(["visible.svg"]);
  });
});

describe("Markdown recognition limits", () => {
  it("retains Unicode labels and rejects notes beyond the UTF-8 byte limit", () => {
    const label = "Ä 漢 😀 \ud800x";
    expect(findMarkdownInkbookEmbeds(`![${label}](drawing.svg)`)[0]?.description).toBe(label);
    expect(
      findMarkdownInkbookEmbeds(
        `${"a".repeat(MARKDOWN_EMBED_LIMITS.inputBytes)}\n![[drawing.svg]]`,
      ),
    ).toEqual([]);
  });

  it("fails closed when candidate capacity is exceeded in either native syntax", () => {
    for (const embed of ["![[drawing.svg]]", "![](drawing.svg)"]) {
      const source = `${embed}\n`.repeat(MARKDOWN_EMBED_LIMITS.matches + 1);
      expect(findMarkdownInkbookEmbeds(source)).toEqual([]);
    }
  });
});

describe("Legacy syntax rejection", () => {
  it.each([
    "!inkbook[[folder/drawing.svg|Drawing]]",
    "!inkbook[Drawing](<folder/my page.svg>)",
    "!inkbook[[drawing.svg|400]]",
  ])("leaves old marker text host-owned: %s", (markdown) => {
    expect(findMarkdownInkbookEmbeds(markdown)).toEqual([]);
  });
});
