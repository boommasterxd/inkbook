import { expect, it } from "vitest";
import { PortableMathRenderer } from "../../../../src/obsidian/text/portable-math-renderer";
import { layoutTextMarkdown } from "../../../../src/rendering/text/text-layout";
import { TEXT_HEADING_SCALES } from "../../../../src/domain/text/text-layout-style";
import { parseTextMarkdown } from "../../../fixtures/domain/text-source";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { textElement } from "../../../fixtures/rendering/text";

const style = { ...textElement().style, fontSize: 20 };
const measure = {
  measure: (text: string, font: typeof style) => ({
    width: text.length * font.fontSize * 0.5,
    ascent: font.fontSize * 0.8,
    descent: font.fontSize * 0.2,
  }),
};

it.each([1, 3, 6])(
  "prepares heading %i text and true bold formula glyphs at the same size",
  async (level) => {
    const source = `${"#".repeat(level)} Heading $x+1$`;
    const scheduler = createTestWorkScheduler();
    const math = new PortableMathRenderer(scheduler);
    try {
      const result = await layoutTextMarkdown(
        { document: parseTextMarkdown(source, { style }), width: 700, style },
        { measure, math, scheduler },
      );
      const size = style.fontSize * TEXT_HEADING_SCALES[level - 1]!;
      expect(
        result.layout.lines
          .flatMap((line) => line.runs)
          .every((run) => run.style?.fontSize === size && run.style.bold),
      ).toBe(true);
      const bold = await math.resolve("x+1", false, size, undefined, 700, { bold: true });
      const plain = await math.resolve("x+1", false, size, undefined, 700);
      expect(result.layout.math?.[0]?.paths).toEqual(bold.paths);
      expect(bold.paths).not.toEqual(plain.paths);
    } finally {
      math.dispose();
    }
  },
);

it("honors an explicit Bold-off override on a heading formula without changing its size", async () => {
  const source = "# Heading $x+1$";
  const start = source.indexOf("$");
  const scheduler = createTestWorkScheduler();
  const math = new PortableMathRenderer(scheduler);
  try {
    const document = parseTextMarkdown(source, {
      style,
      ranges: [{ start, end: source.length, style: { bold: false } }],
    });
    const result = await layoutTextMarkdown(
      { document, width: 700, style },
      { measure, math, scheduler },
    );
    const plain = await math.resolve("x+1", false, 40, undefined, 700);
    expect(result.layout.math?.[0]?.paths).toEqual(plain.paths);
    expect(result.layout.lines[0]?.runs[0]?.style).toMatchObject({ bold: true, fontSize: 40 });
  } finally {
    math.dispose();
  }
});

it("wraps long heading math at its original glyph size and keeps following prose below fractions", async () => {
  const latex = "a+b+c+d+e+f+g+h+i+j=\\frac{1}{\\sqrt{x}}";
  const source = `# Result $${latex}$\n\nFollowing text`;
  const scheduler = createTestWorkScheduler();
  const math = new PortableMathRenderer(scheduler);
  try {
    const result = await layoutTextMarkdown(
      { document: parseTextMarkdown(source, { style }), width: 220, style },
      { measure, math, scheduler },
    );
    const formula = result.layout.math![0]!;
    const natural = await math.resolve(latex, false, 40, undefined, undefined, { bold: true });
    expect(formula.width).toBeLessThanOrEqual(220);
    expect(formula.height).toBeGreaterThan(natural.height);
    expect(formula.paths.length).toBeGreaterThanOrEqual(natural.paths.length);
    expect(pathWidth(formula.paths[0]!.d)).toBeCloseTo(pathWidth(natural.paths[0]!.d), 2);
    const following = result.layout.lines.find((line) =>
      line.runs.some((run) => run.text.includes("Following")),
    )!;
    expect(following.y).toBeGreaterThanOrEqual(formula.y + formula.height - 0.001);
  } finally {
    math.dispose();
  }
});

function pathWidth(path: string): number {
  const numbers = (path.match(/-?\d+(?:\.\d+)?/gu) ?? []).map(Number);
  const xs = numbers.filter((_, index) => index % 2 === 0);
  return Math.max(...xs) - Math.min(...xs);
}
