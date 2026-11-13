import { describe, expect, it, vi } from "vitest";
import { AbstractMathDocument } from "@mathjax/src/js/core/MathDocument.js";

import { PortableMathRenderer } from "../../../../src/obsidian/text/portable-math-renderer";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";

describe("offline portable MathJax", () => {
  it("converts real inline/display TeX and Unicode glyphs to bounded normalized paths", async () => {
    const renderer = new PortableMathRenderer(createTestWorkScheduler());
    try {
      for (const latex of [
        "x^2 + y^2 = z^2",
        "\\frac{1}{\\sqrt{2}}",
        "\\sum_{i=1}^{n} i=\\frac{n(n+1)}{2}",
        "\\text{Größe} + \\alpha + \\infty",
        "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}",
      ]) {
        const value = await renderer.resolve(latex, true, 24);
        expect(value.width).toBeGreaterThan(0);
        expect(value.height).toBeGreaterThan(0);
        expect(value.ascent + value.descent).toBeCloseTo(value.height);
        expect(value.paths.length).toBeGreaterThan(0);
        expect(value.paths.every((path) => /^[MLCQZ0-9+.,\s-]+$/u.test(path.d))).toBe(true);
      }
    } finally {
      renderer.dispose();
    }
  });

  it("reuses exact formula geometry, scales independently and releases ownership on disposal", async () => {
    const renderer = new PortableMathRenderer(createTestWorkScheduler());
    const initial = await renderer.resolve("x+1", false, 20);
    expect(await renderer.resolve("x+1", false, 20)).toBe(initial);
    const larger = await renderer.resolve("x+1", false, 40);
    expect(larger.width).toBeCloseTo(initial.width * 2, 2);
    const bounded = await renderer.resolve("x+1", false, 20, undefined, 700);
    expect(bounded.width).toBeCloseTo(initial.width, 2);
    const bold = await renderer.resolve("x+1", false, 20, undefined, undefined, { bold: true });
    expect(bold.paths).not.toEqual(initial.paths);
    expect(bold.paths).toEqual((await renderer.resolve("\\boldsymbol{x+1}", false, 20)).paths);
    expect(await renderer.resolve("x+1", false, 20, undefined, undefined, { bold: true })).toBe(
      bold,
    );
    expect(await renderer.resolve("x+1", false, 20, undefined, undefined, { bold: false })).toBe(
      initial,
    );
    const largerBold = await renderer.resolve("x+1", false, 40, undefined, undefined, {
      bold: true,
    });
    expect(largerBold.width).toBeCloseTo(bold.width * 2, 2);
    renderer.dispose();
    await expect(renderer.resolve("x+1", false, 20)).rejects.toThrow("disposed");
  });

  it("rejects excessive TeX and unsupported macros without retaining arbitrary markup", async () => {
    const renderer = new PortableMathRenderer(createTestWorkScheduler());
    try {
      await expect(renderer.resolve("x".repeat(8193), false, 20)).rejects.toThrow("limits");
      expect(
        (
          await renderer.resolve(`x%${"x".repeat(8190)}`, false, 20, undefined, undefined, {
            bold: true,
          })
        ).paths.length,
      ).toBeGreaterThan(0);
      await expect(renderer.resolve("\\href{https://example.com}{x}", false, 20)).rejects.toThrow();
    } finally {
      renderer.dispose();
    }
  });

  it("preserves absolute TeX dimensions across native sizes and reuses only matching natural geometry", async () => {
    const renderer = new PortableMathRenderer(createTestWorkScheduler());
    try {
      const latex = "\\rule{10px}{2px}";
      const initial = await renderer.resolve(latex, false, 20, undefined, 100);
      const larger = await renderer.resolve(latex, false, 40, undefined, 200);
      expect(initial.width).toBeCloseTo(10, 2);
      expect(larger.width).toBeCloseTo(initial.width, 2);
      expect(larger.height).toBeCloseTo(initial.height, 2);
      expect(larger).not.toBe(initial);
      expect(await renderer.resolve(latex, false, 20, undefined, 200)).toBe(initial);
      expect(await renderer.resolve(latex, false, 40, undefined, 100)).toBe(larger);
    } finally {
      renderer.dispose();
    }
  });
});

describe("isolated formula processing", () => {
  it("keeps user macro definitions local to their own self-contained formula", async () => {
    const renderer = new PortableMathRenderer(createTestWorkScheduler());
    try {
      expect(
        (await renderer.resolve("\\newcommand{\\saved}{x}\\saved", false, 20)).paths.length,
      ).toBeGreaterThan(0);
      await expect(renderer.resolve("\\saved", false, 20)).rejects.toThrow();
      expect((await renderer.resolve("y+1", false, 20)).paths.length).toBeGreaterThan(0);
    } finally {
      renderer.dispose();
    }
  });

  it("keeps concurrent formula geometry independent while a local glyph range awaits shared admission", async () => {
    let checkpoint = 0;
    let resume!: () => void;
    let entered!: () => void;
    const suspended = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const scheduler = createTestWorkScheduler({
      checkpoint: () => {
        if (++checkpoint === 2) {
          entered();
          return new Promise<void>((resolve) => {
            resume = resolve;
          });
        }
        return undefined;
      },
    });
    const renderer = new PortableMathRenderer(scheduler);
    const reference = new PortableMathRenderer(createTestWorkScheduler());
    try {
      const first = renderer.resolve("\\text{Größe}", false, 24);
      await suspended;
      await renderer.resolve("a+b", true, 20);
      resume();
      expect(await first).toEqual(await reference.resolve("\\text{Größe}", false, 24));
    } finally {
      renderer.dispose();
      reference.dispose();
    }
  });
});

describe("bounded formula working sets", () => {
  it("bounds retained path items even when compact rule paths remain below the character budget", async () => {
    const convert = vi.spyOn(AbstractMathDocument.prototype, "convertPromise");
    const renderer = new PortableMathRenderer(createTestWorkScheduler());
    const rule = "\\rule{1em}{.1em}";
    const formula = (index: number) => `\\def\\r{${rule.repeat(8)}}${"\\r".repeat(750)}+${index}`;
    try {
      const first = await renderer.resolve(formula(0), true, 20);
      const second = await renderer.resolve(formula(1), true, 20);
      const third = await renderer.resolve(formula(2), true, 20);
      expect(
        [first, second, third].reduce(
          (sum, value) => sum + value.paths.reduce((total, path) => total + path.d.length, 0),
          0,
        ),
      ).toBeLessThan(2_000_000);
      expect(await renderer.resolve(formula(2), true, 20)).toBe(third);
      expect(await renderer.resolve(formula(1), true, 20)).toBe(second);
      expect(convert).toHaveBeenCalledTimes(3);
      expect(await renderer.resolve(formula(0), true, 20)).not.toBe(first);
      expect(convert).toHaveBeenCalledTimes(4);
    } finally {
      renderer.dispose();
      convert.mockRestore();
    }
  });

  it("bounds retained source keys across annotated revisions and promotes reused geometry", async () => {
    const convert = vi.spyOn(AbstractMathDocument.prototype, "convertPromise");
    const renderer = new PortableMathRenderer(createTestWorkScheduler());
    const formulas = Array.from(
      { length: 150 },
      (_entry, index) => `x% revision ${index}: ${"assumption ".repeat(700)}`,
    );
    try {
      const initial = await renderer.resolve(formulas[0]!, false, 20);
      const second = await renderer.resolve(formulas[1]!, false, 20);
      for (const formula of formulas.slice(2, 140)) await renderer.resolve(formula, false, 20);
      expect(await renderer.resolve(formulas[0]!, false, 20)).toBe(initial);
      for (const formula of formulas.slice(140)) await renderer.resolve(formula, false, 20);
      expect(convert).toHaveBeenCalledTimes(150);
      expect(await renderer.resolve(formulas[0]!, false, 20)).toBe(initial);
      expect(convert).toHaveBeenCalledTimes(150);
      expect(await renderer.resolve(formulas[1]!, false, 20)).not.toBe(second);
      expect(convert).toHaveBeenCalledTimes(151);
    } finally {
      renderer.dispose();
      convert.mockRestore();
    }
  });

  it("evicts old large formula paths while retaining the recently reused expression", async () => {
    const convert = vi.spyOn(AbstractMathDocument.prototype, "convertPromise");
    const renderer = new PortableMathRenderer(createTestWorkScheduler());
    const formula = (index: number) =>
      `\\underbrace{${"x".repeat(600)}}_{600\\ \\mathrm{factors}}+${index}`;
    try {
      const initial = await renderer.resolve(formula(0), true, 20);
      const second = await renderer.resolve(formula(1), true, 20);
      let characters = [initial, second].reduce(
        (sum, value) => sum + value.paths.reduce((total, path) => total + path.d.length, 0),
        0,
      );
      let generated = 2;
      const maximumEntries =
        Math.ceil(2_000_000 / initial.paths.reduce((total, path) => total + path.d.length, 0)) + 1;
      while (characters <= 2_000_000 && generated < maximumEntries) {
        expect(await renderer.resolve(formula(0), true, 20)).toBe(initial);
        const value = await renderer.resolve(formula(generated++), true, 20);
        characters += value.paths.reduce((total, path) => total + path.d.length, 0);
      }
      expect(characters).toBeGreaterThan(2_000_000);
      expect(await renderer.resolve(formula(0), true, 20)).toBe(initial);
      expect(convert).toHaveBeenCalledTimes(generated);
      expect(await renderer.resolve(formula(1), true, 20)).not.toBe(second);
      expect(convert).toHaveBeenCalledTimes(generated + 1);
    } finally {
      renderer.dispose();
      convert.mockRestore();
    }
  });
});

describe("formula cache cancellation", () => {
  it("does not retain a cancelled preparation or bypass cancellation on a cached expression", async () => {
    const convert = vi.spyOn(AbstractMathDocument.prototype, "convertPromise");
    const abort = new AbortController();
    let entered!: () => void;
    let resume!: () => void;
    let checkpoint = 0;
    const suspended = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const renderer = new PortableMathRenderer(
      createTestWorkScheduler({
        checkpoint: () => {
          if (++checkpoint === 2) {
            entered();
            return new Promise<void>((resolve) => {
              resume = resolve;
            });
          }
          return undefined;
        },
      }),
    );
    try {
      const pending = renderer.resolve("x+1", false, 20, abort.signal);
      await suspended;
      abort.abort(new Error("obsolete formula"));
      resume();
      await expect(pending).rejects.toThrow("obsolete formula");
      expect(convert).toHaveBeenCalledTimes(1);
      const value = await renderer.resolve("x+1", false, 20);
      expect(convert).toHaveBeenCalledTimes(2);
      expect(await renderer.resolve("x+1", false, 20)).toBe(value);
      await expect(renderer.resolve("x+1", false, 20, abort.signal)).rejects.toThrow(
        "obsolete formula",
      );
      expect(convert).toHaveBeenCalledTimes(2);
    } finally {
      renderer.dispose();
      convert.mockRestore();
    }
  });
});

describe("width-aware portable equations", () => {
  it("preserves boxed interiors and solid table rules as portable filled outlines", async () => {
    const renderer = new PortableMathRenderer(createTestWorkScheduler());
    try {
      const boxed = await renderer.resolve("\\boxed{x}", true, 24);
      expect(
        boxed.paths.some((path) => path.fillRule === "evenodd" && path.d.split("M").length === 3),
      ).toBe(true);
      const table = await renderer.resolve(
        "\\begin{array}{c|c}a&b\\\\\\hline c&d\\end{array}",
        true,
        24,
        undefined,
        120,
      );
      expect(table.paths.length).toBeGreaterThanOrEqual(6);
      expect(table.width).toBeLessThanOrEqual(120);
    } finally {
      renderer.dispose();
    }
  });

  it("retains the complete inline equation rather than only the first SVG operator fragment", async () => {
    const renderer = new PortableMathRenderer(createTestWorkScheduler());
    try {
      const letter = await renderer.resolve("x", false, 24);
      const expression = await renderer.resolve("x+1", false, 24);
      expect(expression.width).toBeGreaterThan(letter.width * 2);
      expect(expression.paths.length).toBeGreaterThan(letter.paths.length);
    } finally {
      renderer.dispose();
    }
  });

  it("wraps long displayed operator chains before fitting and keys reuse by available width", async () => {
    const renderer = new PortableMathRenderer(createTestWorkScheduler());
    try {
      const latex = "a_1+a_2+a_3+a_4+a_5+a_6+a_7+a_8+a_9+a_{10}=b";
      const natural = await renderer.resolve(latex, true, 24);
      const narrow = await renderer.resolve(latex, true, 24, undefined, 120);
      expect(narrow.width).toBeLessThanOrEqual(120);
      const xCoordinates = narrow.paths.flatMap((path) =>
        (path.d.match(/-?\d+(?:\.\d+)?/gu) ?? [])
          .map(Number)
          .filter((_value, index) => index % 2 === 0),
      );
      expect(Math.max(...xCoordinates)).toBeLessThanOrEqual(120);
      expect(narrow.height).toBeGreaterThan(natural.height);
      expect(narrow.paths).toHaveLength(natural.paths.length);
      expect(await renderer.resolve(latex, true, 24, undefined, 120)).toBe(narrow);
      const wide = await renderer.resolve(latex, true, 24, undefined, 600);
      expect(wide.height).toBeLessThan(narrow.height);
    } finally {
      renderer.dispose();
    }
  });
});

describe("portable inline formula wrapping", () => {
  it("wraps complete inline fractions at their original font size and first-line baseline", async () => {
    const renderer = new PortableMathRenderer(createTestWorkScheduler());
    const latex = "\\sum_{i=1}^n\\frac{a_i}{b_i}+x_1+x_2+x_3+x_4+x_5+x_6";
    try {
      const natural = await renderer.resolve(latex, false, 24);
      const wrapped = await renderer.resolve(latex, false, 24, undefined, 120);
      expect(wrapped.width).toBeLessThanOrEqual(120);
      expect(wrapped.height).toBeGreaterThan(natural.height * 2);
      expect(wrapped.ascent).toBeCloseTo(natural.ascent, 2);
      expect(wrapped.paths).toHaveLength(natural.paths.length);
      for (const [index, path] of wrapped.paths.entries()) {
        const previous = pathBounds(natural.paths[index]!.d);
        const current = pathBounds(path.d);
        expect(current.width).toBeCloseTo(previous.width, 2);
        expect(current.height).toBeCloseTo(previous.height, 2);
      }
      expect(await renderer.resolve(latex, false, 24, undefined, 120)).toBe(wrapped);
      const wide = await renderer.resolve(latex, false, 24, undefined, 1000);
      expect(wide.width).toBeCloseTo(natural.width, 2);
      expect(wide.ascent).toBeCloseTo(natural.ascent, 2);
      expect(wide.height).toBeCloseTo(natural.height, 2);
    } finally {
      renderer.dispose();
    }
  });

  it("keeps bold Greek and operator-chain glyphs complete across narrow multiline output", async () => {
    const renderer = new PortableMathRenderer(createTestWorkScheduler());
    const latex = "\\alpha+\\beta+\\gamma+\\delta+\\epsilon+\\zeta+\\eta+\\theta % tail";
    try {
      const natural = await renderer.resolve(latex, false, 28, undefined, undefined, {
        bold: true,
      });
      const wrapped = await renderer.resolve(latex, false, 28, undefined, 120, { bold: true });
      expect(wrapped.width).toBeLessThanOrEqual(120);
      expect(wrapped.height).toBeGreaterThan(natural.height);
      expect(wrapped.paths).toHaveLength(natural.paths.length);
      for (const [index, path] of wrapped.paths.entries())
        expect(pathBounds(path.d).width).toBeCloseTo(pathBounds(natural.paths[index]!.d).width, 2);
    } finally {
      renderer.dispose();
    }
  });
});

describe("indivisible portable equations", () => {
  it("fits indivisible matrices proportionally while preserving explicit aligned rows", async () => {
    const renderer = new PortableMathRenderer(createTestWorkScheduler());
    try {
      const latex =
        "\\begin{pmatrix}abcdefghijklmnop&qrstuvwxyz\\\\0123456789&abcdefghijklmnop\\end{pmatrix}";
      const natural = await renderer.resolve(latex, true, 24);
      const fitted = await renderer.resolve(latex, true, 24, undefined, 80);
      expect(fitted.width).toBeLessThanOrEqual(80);
      expect(fitted.height).toBeLessThan(natural.height);
      expect(fitted.paths.length).toBe(natural.paths.length);
      const horizontalCoordinates = fitted.paths.flatMap((path) =>
        (path.d.match(/-?\d+(?:\.\d+)?/gu) ?? [])
          .map(Number)
          .filter((_value, index) => index % 2 === 0),
      );
      expect(Math.min(...horizontalCoordinates)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...horizontalCoordinates)).toBeLessThanOrEqual(80);
      const single = await renderer.resolve("x=1", true, 24, undefined, 300);
      const aligned = await renderer.resolve(
        "\\begin{aligned}x&=1\\\\y&=2\\end{aligned}",
        true,
        24,
        undefined,
        300,
      );
      expect(aligned.height).toBeGreaterThan(single.height * 1.5);
      expect(aligned.width).toBeLessThanOrEqual(300);
    } finally {
      renderer.dispose();
    }
  });
});

function pathBounds(d: string) {
  const coordinates = (d.match(/-?\d+(?:\.\d+)?/gu) ?? []).map(Number);
  const x = coordinates.filter((_value, index) => index % 2 === 0);
  const y = coordinates.filter((_value, index) => index % 2 === 1);
  return { width: Math.max(...x) - Math.min(...x), height: Math.max(...y) - Math.min(...y) };
}
