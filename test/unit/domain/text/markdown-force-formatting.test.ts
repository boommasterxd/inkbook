import { describe, expect, it } from "vitest";

import { forceTextMarkdownMarkSteps } from "../../../../src/domain/text/markdown-formatting";
import { forceTextMarkdownMark, parseTextMarkdown } from "../../../fixtures/domain/text-source";
import { applyTextEditsSteps } from "../../../../src/domain/text/text-source-edits";
import { textElement } from "../schema/fixtures";

describe("explicit Markdown mark values", () => {
  it("removes a mark from mixed ordinary content without enabling it on the plain part", () => {
    const source = "**bold *both* end** plain `**literal**` $x_1$";
    const result = forceTextMarkdownMark(source, { start: 0, end: source.length }, "bold", false);
    expect(result.source).toBe("bold *both* end plain `**literal**` $x_1$");
    expect(
      forceTextMarkdownMark(result.source, { start: 0, end: result.source.length }, "bold", false)
        .changes,
    ).toEqual([]);
  });

  it("marks every ordinary paragraph while preserving code, math, and independent syntax", () => {
    const source = "# **bold** *italic* `code` $x$\n\n~~strike~~ plain\n\n$$x_1$$";
    const result = forceTextMarkdownMark(source, { start: 0, end: source.length }, "bold", true);
    expect(result.source).toBe("# **bold *italic* `code` $x$**\n\n**~~strike~~ plain**\n\n$$x_1$$");
    const document = parseTextMarkdown(result.source, { style: textElement().style });
    expect(
      document.blocks[0]!.runs.filter((run) => run.text.trim()).every((run) => run.style.bold),
    ).toBe(true);
    expect(document.blocks[0]!.runs.some((run) => run.code && run.text === "code")).toBe(true);
    expect(document.blocks[0]!.runs.find((run) => run.kind === "math")!.latex).toBe("x");
    expect(document.blocks[document.blocks.length - 1]!.runs[0]!.latex).toBe("x_1");
    expect(
      forceTextMarkdownMark(
        result.source,
        { start: 0, end: result.source.length },
        "bold",
        true,
        document,
      ).changes,
    ).toEqual([]);
  });

  it("retains other marks when forcing italic and strikethrough values", () => {
    const source = "**bold *both* end** ~~gone~~ plain";
    const italic = forceTextMarkdownMark(source, { start: 0, end: source.length }, "italic", false);
    expect(italic.source).toBe("**bold both end** ~~gone~~ plain");
    const strike = forceTextMarkdownMark(
      italic.source,
      { start: 0, end: italic.source.length },
      "strikethrough",
      false,
    );
    expect(strike.source).toBe("**bold both end** gone plain");
  });

  it("retains valid whitespace flanking and returns no changes for already satisfied selections", () => {
    const source = "  **bold** plain  ";
    const result = forceTextMarkdownMark(source, { start: 0, end: source.length }, "bold", true);
    expect(result.source).toBe("  **bold plain**  ");
    expect(
      forceTextMarkdownMark(result.source, { start: 0, end: result.source.length }, "bold", true)
        .changes,
    ).toEqual([]);
    expect(forceTextMarkdownMark("plain", { start: 0, end: 5 }, "italic", false).changes).toEqual(
      [],
    );
  });
});

describe("source-authoritative forced formatting state", () => {
  it("rebases independent styles through the emitted changes and retains equivalent resumable output", () => {
    const source = "**bold** plain";
    const selection = { start: 0, end: source.length };
    const steps = forceTextMarkdownMarkSteps(source, selection, "bold", false);
    let result = steps.next();
    while (!result.done) result = steps.next();
    expect(result.value).toEqual(forceTextMarkdownMark(source, selection, "bold", false));
    const edited = applyTextEditsSteps(
      {
        source,
        ranges: [{ start: 2, end: 6, style: { underline: true } }],
        paragraphs: [{ start: 0, alignment: "center" }],
      },
      result.value.changes,
    );
    let state = edited.next();
    while (!state.done) state = edited.next();
    expect(state.value).toEqual({
      source: "bold plain",
      ranges: [{ start: 0, end: 4, style: { underline: true } }],
      paragraphs: [{ start: 0, alignment: "center" }],
    });
  });
});
