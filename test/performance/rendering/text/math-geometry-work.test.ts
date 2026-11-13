import { describe, expect, it, vi } from "vitest";
import { AbstractMathDocument } from "@mathjax/src/js/core/MathDocument.js";

import type { TextStyleV2 } from "../../../../src/domain/schema/public";
import { fitTextMathGeometry } from "../../../../src/rendering/text/math-geometry-fit";
import { layoutTextMarkdown } from "../../../../src/rendering/text/text-layout";
import { PortableMathRenderer } from "../../../../src/obsidian/text/portable-math-renderer";
import { parseTextMarkdown } from "../../../fixtures/domain/text-source";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";

const style: TextStyleV2 = {
  fontFamily: "inter",
  fontSize: 20,
  color: { type: "theme-text" },
  opacity: 1,
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
};

describe("bounded canonical math fitting", () => {
  it("reads each retained source path once at capacity, reuses fitting geometry and cancels obsolete staging", async () => {
    let pathReads = 0;
    const abort = new AbortController();
    let cancelAt = Infinity;
    const value = {
      width: 160,
      height: 80,
      ascent: 60,
      descent: 20,
      paths: Array.from({ length: 16_000 }, () => ({
        get d() {
          if (++pathReads === cancelAt) abort.abort();
          return "M0 0L160 80Z";
        },
      })),
    };
    const scheduler = createTestWorkScheduler();
    expect(await fitTextMathGeometry(value, 160, { scheduler })).toBe(value);
    expect(pathReads).toBe(0);
    const fitted = await fitTextMathGeometry(value, 80, { scheduler });
    expect(pathReads).toBe(16_000);
    expect(fitted.paths).toHaveLength(16_000);
    expect(fitted.paths[0]!.d).toBe("M0 0 L80 40 Z");
    expect(fitted).toMatchObject({ width: 80, height: 40, ascent: 30, descent: 10 });
    cancelAt = pathReads + 3;
    await expect(
      fitTextMathGeometry(value, 40, { scheduler, signal: abort.signal }),
    ).rejects.toThrow();
    expect(pathReads).toBe(16_003);
  });
});

describe("fitting formula resize work", () => {
  it("reuses a fitting equation through changing field widths without repeating MathJax conversion", async () => {
    const convert = vi.spyOn(AbstractMathDocument.prototype, "convertPromise");
    const math = new PortableMathRenderer(createTestWorkScheduler());
    const latex = "x^2=\\frac{1}{2}";
    try {
      const initial = await math.resolve(latex, false, 24, undefined, 500);
      expect(convert).toHaveBeenCalledOnce();
      for (const width of [480, 360, 240, 120, 240, 500])
        expect(await math.resolve(latex, false, 24, undefined, width)).toBe(initial);
      expect(convert).toHaveBeenCalledOnce();
      const abort = new AbortController();
      abort.abort(new Error("obsolete field width"));
      await expect(math.resolve(latex, false, 24, abort.signal, 400)).rejects.toThrow(
        "obsolete field width",
      );
      expect(convert).toHaveBeenCalledOnce();
      math.dispose();
      await expect(math.resolve(latex, false, 24, undefined, 400)).rejects.toThrow("disposed");
    } finally {
      math.dispose();
      convert.mockRestore();
    }
  });
});

describe("retained formula field geometry", () => {
  it("converts each long formula style and width once before reusing all complete geometry", async () => {
    const convert = vi.spyOn(AbstractMathDocument.prototype, "convertPromise");
    const math = new PortableMathRenderer(createTestWorkScheduler());
    const latex = Array.from({ length: 40 }, (_entry, index) => `\\frac{x_{${index}}}{y}`).join(
      "+",
    );
    const variants = [
      { width: undefined, bold: false },
      { width: 120, bold: false },
      { width: 120, bold: true },
      { width: 360, bold: true },
    ];
    try {
      const prepared = [];
      for (const variant of variants)
        prepared.push(await math.resolve(latex, false, 24, undefined, variant.width, variant));
      // Plain and bold retain their natural geometry; the three narrow variants
      // additionally need their actual container-dependent line breaks.
      expect(convert).toHaveBeenCalledTimes(5);
      expect(
        prepared.reduce(
          (total, value) => total + value.paths.reduce((sum, path) => sum + path.d.length, 0),
          0,
        ),
      ).toBeLessThanOrEqual(2_000_000);
      for (const [index, variant] of variants.entries()) {
        expect(await math.resolve(latex, false, 24, undefined, variant.width, variant)).toBe(
          prepared[index],
        );
        expect(prepared[index]!.paths).toHaveLength(prepared[0]!.paths.length);
      }
      expect(convert).toHaveBeenCalledTimes(5);
      const abort = new AbortController();
      abort.abort(new Error("obsolete math"));
      await expect(math.resolve(latex, false, 24, abort.signal, 120)).rejects.toThrow(
        "obsolete math",
      );
      expect(convert).toHaveBeenCalledTimes(5);
      math.dispose();
      await expect(math.resolve(latex, false, 24)).rejects.toThrow("disposed");
    } finally {
      math.dispose();
      convert.mockRestore();
    }
  });

  it("reuses fifty equations across plain text edits and rebuilds only a changed equation", async () => {
    const convert = vi.spyOn(AbstractMathDocument.prototype, "convertPromise");
    const scheduler = createTestWorkScheduler();
    const math = new PortableMathRenderer(scheduler);
    const rows = Array.from(
      { length: 50 },
      (_entry, index) => `Trial ${index + 1}: $x_{${index + 1}}=${index + 1}^2$`,
    );
    const source = `Observations\n\n${rows.join("\n")}`;
    const measure = {
      measure: (text: string) => ({ width: text.length * 10, ascent: 16, descent: 4 }),
    };
    const prepare = (value: string) =>
      layoutTextMarkdown(
        { document: parseTextMarkdown(value, { style }), width: 500, style },
        { measure, scheduler, math },
      );
    try {
      const initial = await prepare(source);
      expect(initial.layout.math).toHaveLength(50);
      expect(convert).toHaveBeenCalledTimes(50);
      const edited = await prepare(source.replace("Observations", "Revised observations"));
      expect(convert).toHaveBeenCalledTimes(50);
      expect(edited.layout.math![0]!.start).not.toBe(initial.layout.math![0]!.start);
      for (const [index, entry] of edited.layout.math!.entries())
        expect(entry.paths).toBe(initial.layout.math![index]!.paths);
      const changed = await prepare(source.replace("x_{25}=25^2", "x_{25}=25^3"));
      expect(convert).toHaveBeenCalledTimes(51);
      expect(changed.layout.math![24]!.paths).not.toBe(initial.layout.math![24]!.paths);
      expect(changed.layout.math![23]!.paths).toBe(initial.layout.math![23]!.paths);
      expect(changed.layout.math![25]!.paths).toBe(initial.layout.math![25]!.paths);
    } finally {
      math.dispose();
      convert.mockRestore();
    }
  });
});
