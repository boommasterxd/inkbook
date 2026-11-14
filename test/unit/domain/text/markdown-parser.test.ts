import { describe, expect, it } from "vitest";

import type { TextStyleV2 } from "../../../../src/domain/schema/public";
import { parseTextMarkdownSteps } from "../../../../src/domain/text/markdown-parser";
import { parseTextMarkdown } from "../../../fixtures/domain/text-source";
import { textStyleAt } from "../../../../src/domain/text/text-style-segments";

const style: TextStyleV2 = {
  fontFamily: "Inkbook Sans",
  fontSize: 20,
  color: { type: "theme-text" },
  opacity: 1,
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
};

function parse(source: string) {
  return parseTextMarkdown(source, { style });
}

describe("source-authoritative text Markdown", () => {
  it("resolves nested marks while retaining source offsets and literal escaped syntax", () => {
    const source = "**bold *both* end** and ~~gone~~ and `*literal*` and \\*safe\\*";
    const document = parse(source);
    expect(document.source).toBe(source);
    const runs = document.blocks.flatMap((block) => block.runs);
    expect(runs.map((run) => run.text).join("")).toBe(
      "bold both end and gone and *literal* and *safe*",
    );
    expect(runs.find((run) => run.text === "both")?.style).toMatchObject({
      bold: true,
      italic: true,
    });
    expect(runs.find((run) => run.text === "gone")?.style.strikethrough).toBe(true);
    expect(runs.find((run) => run.code)?.text).toBe("*literal*");
    const both = runs.find((run) => run.text === "both")!;
    expect(source.slice(both.start, both.end)).toBe("both");
    expect(parse("***both***").blocks[0]!.runs[0]!.style).toMatchObject({
      bold: true,
      italic: true,
    });
  });

  it("recognizes headings, nested ordered and unordered items, paragraphs, and empty lines", () => {
    const source = "# Title\n\nFirst line\nsecond line\n- item\n  3. nested\n###### Small";
    const blocks = parse(source).blocks;
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "paragraph",
      "list-item",
      "list-item",
      "heading",
    ]);
    expect(blocks[0]).toMatchObject({ start: 0, contentStart: 2, headingLevel: 1 });
    expect(blocks[1]!.runs).toEqual([]);
    expect(blocks[2]!.runs.map((run) => run.text).join("")).toBe("First line\nsecond line");
    expect(blocks[3]!.list).toEqual({ ordered: false, number: 1, marker: "-", depth: 0 });
    expect(blocks[4]!.list).toEqual({ ordered: true, number: 3, marker: "3.", depth: 1 });
    expect(blocks[5]!.headingLevel).toBe(6);
  });

  it("keeps math opaque and maps multiline display and inline math to complete source spans", () => {
    const source = "Value $x_*^2$ and \\$literal\n\n$$\n\\frac{a}{b}\n+ c\n$$";
    const document = parse(source);
    const inline = document.blocks[0]!.runs.find((run) => run.kind === "math")!;
    expect(inline.latex).toBe("x_*^2");
    expect(inline.display).toBe(false);
    expect(source.slice(inline.start, inline.end)).toBe("$x_*^2$");
    const display = document.blocks[document.blocks.length - 1]!;
    expect(display.kind).toBe("math");
    expect(display.runs[0]!.latex).toBe("\\frac{a}{b}\n+ c");
    expect(display.runs[0]!.display).toBe(true);
    expect(
      parse("before $$x$$ after").blocks[0]!.runs.find((run) => run.kind === "math")!.display,
    ).toBe(true);
    expect(source.slice(display.runs[0]!.start, display.runs[0]!.end)).toBe(
      "$$\n\\frac{a}{b}\n+ c\n$$",
    );
  });

  it("preserves incomplete and unsupported syntax as inert text", () => {
    const source =
      "**unfinished $math `code\n<script>alert(1)</script> ![external](https://example.com) word_name";
    expect(
      parse(source)
        .blocks.flatMap((block) => block.runs)
        .map((run) => run.text)
        .join(""),
    ).toBe(source);
    expect(parse("$$unclosed").blocks[0]!.kind).toBe("paragraph");
  });
});

describe("text source style resolution", () => {
  it("looks up resolved style segments at inclusive starts and exclusive ends", () => {
    const first = { underline: true };
    const second = { opacity: 0.5 };
    const segments = [
      { start: 2, end: 5, style: first },
      { start: 5, end: 8, style: second },
    ];
    expect(textStyleAt(segments, 2)).toBe(first);
    expect(textStyleAt(segments, 5)).toBe(second);
    expect(textStyleAt(segments, 8)).toEqual({});
    expect(textStyleAt(segments, -1)).toEqual({});
    expect(textStyleAt([], 0)).toEqual({});
  });
  it("retains outer italic when only part of that run becomes bold", () => {
    const runs = parse("***hello** world*").blocks[0]!.runs;
    expect(runs.map((run) => run.text).join("")).toBe("hello world");
    expect(runs[0]!.style).toMatchObject({ bold: true, italic: true });
    expect(runs[runs.length - 1]!.style).toMatchObject({ bold: false, italic: true });
    expect(parse("***hello* world**").blocks[0]!.runs[1]!.style).toMatchObject({
      bold: true,
      italic: false,
    });
  });

  it("maps code and escaped characters across style boundaries without duplicating text", () => {
    const document = parseTextMarkdown("`abcd` \\* line\\\nnext", {
      style,
      ranges: [{ start: 2, end: 3, style: { underline: true } }],
    });
    const runs = document.blocks[0]!.runs;
    expect(runs.map((run) => run.text).join("")).toBe("abcd * line\nnext");
    expect(runs.filter((run) => run.code).map((run) => run.text)).toEqual(["a", "b", "cd"]);
    expect(runs[1]).toMatchObject({ contentStart: 2, contentEnd: 3, style: { underline: true } });
  });

  it("combines independent overlapping style properties and source paragraph overrides", () => {
    const document = parseTextMarkdown("**abcd**\n\nnext", {
      style,
      ranges: [
        { start: 2, end: 6, style: { color: { type: "rgba", value: "#ff0000" }, underline: true } },
        { start: 3, end: 5, style: { fontSize: 30, opacity: 0.4 } },
        { start: 4, end: 6, style: { color: { type: "rgba", value: "#0000ff" } } },
      ],
      paragraphs: [
        { start: 0, alignment: "center" },
        { start: 10, alignment: "right" },
      ],
    });
    const runs = document.blocks[0]!.runs;
    expect(runs.map((run) => run.text)).toEqual(["a", "b", "c", "d"]);
    expect(runs[0]!.style).toMatchObject({
      color: { type: "rgba", value: "#ff0000" },
      fontSize: 20,
      underline: true,
      bold: true,
    });
    expect(runs[2]!.style).toMatchObject({
      color: { type: "rgba", value: "#0000ff" },
      fontSize: 30,
      opacity: 0.4,
      underline: true,
      bold: true,
    });
    expect(document.blocks[0]!.alignment).toBe("center");
    expect(document.blocks[document.blocks.length - 1]!.alignment).toBe("right");
  });

  it("offers resumable parsing of a long single paragraph with identical source-authoritative output", () => {
    const source = "word ".repeat(3000) + "**end**";
    const steps = parseTextMarkdownSteps(source, { style });
    let step = steps.next();
    let checkpoints = 0;
    while (!step.done) {
      checkpoints += 1;
      step = steps.next();
    }
    expect(checkpoints).toBeGreaterThan(50);
    expect(step.value).toEqual(parse(source));
  });
});
