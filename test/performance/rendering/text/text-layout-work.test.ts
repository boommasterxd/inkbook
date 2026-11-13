// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import type { TextStyleV2 } from "../../../../src/domain/schema/public";
import { parseTextMarkdown } from "../../../fixtures/domain/text-source";
import { CanvasTextMeasurer } from "../../../../src/rendering/text/canvas-text-measurer";
import { layoutTextMarkdown } from "../../../../src/rendering/text/text-layout";
import type {
  TextFontResourceBoundaries,
  TextFontResourceResolver,
} from "../../../../src/rendering/text/text-layout-types";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { TextMathSyntaxError } from "../../../../src/rendering/text/text-math-syntax-error";

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

function measurementBoundary(
  resolveFontResourceId?: TextFontResourceResolver,
  fontResourceBoundaries?: TextFontResourceBoundaries,
  nativeLine = (_font: string, fontSize: number, _lineHeight: string) => ({
    ascent: fontSize * 0.95,
    lineHeight: fontSize * 1.3,
  }),
) {
  const context = {
    font: "",
    measureText: vi.fn((text: string) => ({
      width: text.length * 10,
      fontBoundingBoxAscent: 16,
      fontBoundingBoxDescent: 4,
    })),
  };
  const canvas = { width: 300, height: 150, getContext: () => context };
  const createElement = vi.fn(() => canvas);
  const nativeDocument = document.implementation.createHTMLDocument("Text measurements");
  const rectReads = vi.fn();
  const styleWrites = vi.fn();
  const phases: string[] = [];
  const createElementNS = vi.fn((namespace: string | null, tag: string) => {
    const node = nativeDocument.createElementNS(namespace, tag) as HTMLElement;
    if (tag === "div") {
      const setProperty = node.style.setProperty.bind(node.style);
      vi.spyOn(node.style, "setProperty").mockImplementation((...args) => {
        styleWrites(...args);
        phases.push("write");
        setProperty(...args);
      });
    }
    if (tag === "div" || tag === "span")
      vi.spyOn(node, "getBoundingClientRect").mockImplementation(() => {
        rectReads(tag);
        phases.push("read");
        const probe = tag === "span" ? node.parentElement! : node;
        const metrics = nativeLine(
          probe.style.font,
          Number.parseFloat(probe.style.fontSize),
          probe.style.lineHeight,
        );
        return new DOMRect(
          0,
          tag === "span" ? metrics.ascent : 0,
          0,
          tag === "span" ? 0 : metrics.lineHeight,
        );
      });
    return node;
  });
  const createTextNode = vi.fn((text: string) => nativeDocument.createTextNode(text));
  const ownerDocument = {
    createElement,
    createElementNS,
    createTextNode,
    head: nativeDocument.head,
    body: nativeDocument.body,
  } as unknown as Document;
  return {
    context,
    canvas,
    createElement,
    createElementNS,
    createTextNode,
    rectReads,
    styleWrites,
    phases,
    nativeDocument,
    measure: new CanvasTextMeasurer(ownerDocument, resolveFontResourceId, fontResourceBoundaries),
  };
}

describe("bounded native text measurement work", () => {
  it("measures and retains the exact bound face when a new bold face becomes available inside one word", async () => {
    const regularId = "a".repeat(64);
    const boldId = "b".repeat(64);
    let importedBold = false;
    const fonts: string[] = [];
    const boundary = measurementBoundary(
      (_style, range) => (!importedBold || (range?.start ?? 0) < 2 ? regularId : boldId),
      (start, end) => (importedBold && start < 2 && end > 2 ? [2] : []),
    );
    boundary.context.measureText.mockImplementation((text) => {
      fonts.push(boundary.context.font);
      return {
        width: text.length * (boundary.context.font.includes(boldId) ? 12 : 7),
        fontBoundingBoxAscent: 16,
        fontBoundingBoxDescent: 4,
      };
    });
    const boldStyle = { ...style, bold: true };
    const request = {
      document: parseTextMarkdown("abCD", { style: boldStyle }),
      width: 200,
      style: boldStyle,
    };
    const ports = { measure: boundary.measure, scheduler: createTestWorkScheduler() };
    try {
      const previous = await layoutTextMarkdown(request, ports);
      expect(previous.layout.lines[0]!.runs).toMatchObject([
        { text: "abCD", fontResourceId: regularId, width: 28 },
      ]);
      importedBold = true;
      const current = await layoutTextMarkdown(request, ports);
      expect(current.layout.lines[0]!.runs).toMatchObject([
        { text: "ab", fontResourceId: regularId, width: 14 },
        { text: "CD", fontResourceId: boldId, width: 24 },
      ]);
      expect(current.layout.lines[0]!.runs.every((run) => run.style?.fontFamily === "inter")).toBe(
        true,
      );
      expect(previous.layout.lines[0]!.runs[0]!.fontResourceId).toBe(regularId);
      expect(fonts.some((font) => font.includes(`700 20px "inkbook-face-${regularId}"`))).toBe(
        true,
      );
      expect(fonts.some((font) => font.includes(`700 20px "inkbook-face-${boldId}"`))).toBe(true);
      const calls = boundary.context.measureText.mock.calls.length;
      expect(boundary.measure.measure("abCD", boldStyle, regularId).width).toBe(28);
      expect(boundary.context.measureText).toHaveBeenCalledTimes(calls);
    } finally {
      boundary.measure.dispose();
    }
  });
  it("reuses native shaping and line metrics across 3,000 table rows and a width reflow", async () => {
    const boundary = measurementBoundary();
    const source = (
      "| word | word |\n| --- | --- |\n" + "| word | word |\n".repeat(2999)
    ).trimEnd();
    const request = { document: parseTextMarkdown(source, { style }), width: 200, style };
    const ports = { measure: boundary.measure, scheduler: createTestWorkScheduler() };
    try {
      const result = await layoutTextMarkdown(request, ports);
      expect(result.layout.lines).toHaveLength(6000);
      expect(result.layout.tables![0]!.rowHeights).toHaveLength(3000);
      expect(boundary.context.measureText).toHaveBeenCalledTimes(4);
      expect(boundary.rectReads).toHaveBeenCalledTimes(4);
      const reflow = await layoutTextMarkdown({ ...request, width: 120 }, ports);
      expect(reflow.layout.tables![0]!.width).toBe(120);
      expect(boundary.context.measureText).toHaveBeenCalledTimes(4);
      expect(boundary.rectReads).toHaveBeenCalledTimes(4);
    } finally {
      boundary.measure.dispose();
    }
  });
});

it("batches exact font line boxes before shaping and cleans cancelled native probes", async () => {
  const boundary = measurementBoundary(undefined, undefined, (_font, size) => ({
    ascent: Math.floor(size * 64) / 64,
    lineHeight: Math.floor(size * 1.3 * 64) / 64,
  }));
  const fonts = [
    ...[2, 1.6, 1.35, 1.15, 1.05, 1].map((factor) => ({
      style: { ...style, bold: true, fontSize: 20 * factor },
    })),
    { style },
    { style: { ...style, italic: true } },
  ];
  const ports = { scheduler: createTestWorkScheduler() };
  try {
    await boundary.measure.prepareLineMetrics(fonts, ports);
    expect(boundary.phases).toEqual([
      ...Array<string>(16).fill("write"),
      ...Array<string>(16).fill("read"),
    ]);
    expect(boundary.nativeDocument.body.childNodes).toHaveLength(0);
    for (const font of fonts) {
      expect(boundary.measure.measure("word", font.style).lineHeight).toBe(
        Math.floor(font.style.fontSize * 1.3 * 64) / 64,
      );
    }
    await boundary.measure.prepareLineMetrics(fonts, ports);
    expect(boundary.rectReads).toHaveBeenCalledTimes(16);
    expect(boundary.styleWrites).toHaveBeenCalledTimes(16);
    boundary.measure.clear();
    const abort = new AbortController();
    const scheduler = createTestWorkScheduler({
      checkpoint: () => {
        if (boundary.styleWrites.mock.calls.length >= 20) abort.abort();
        return undefined;
      },
    });
    await expect(
      boundary.measure.prepareLineMetrics(fonts, { scheduler, signal: abort.signal }),
    ).rejects.toThrow();
    expect(boundary.styleWrites).toHaveBeenCalledTimes(20);
    expect(boundary.rectReads).toHaveBeenCalledTimes(16);
    expect(boundary.nativeDocument.body.childNodes).toHaveLength(0);
  } finally {
    boundary.measure.dispose();
  }
});

describe("bounded native measurement cache", () => {
  it("retains indentation and tab stops for 3,000 source lines with four native shapes and reuses them", async () => {
    const boundary = measurementBoundary();
    const request = {
      document: parseTextMarkdown(Array.from({ length: 3000 }, () => " \tword").join("\n"), {
        style,
      }),
      width: 100,
      style,
    };
    const ports = { measure: boundary.measure, scheduler: createTestWorkScheduler() };
    try {
      const result = await layoutTextMarkdown(request, ports);
      expect(result.layout.lines).toHaveLength(3000);
      expect(result.layout.lines.every((line) => line.runs.length === 3)).toBe(true);
      expect(result.layout.lines[2999]!.runs).toMatchObject([
        { text: " ", x: 0, width: 10 },
        { text: " ", x: 10, width: 30 },
        { text: "word", x: 40, width: 40 },
      ]);
      expect(boundary.context.measureText).toHaveBeenCalledTimes(4);
      expect(boundary.rectReads).toHaveBeenCalledTimes(2);
      expect(await layoutTextMarkdown(request, ports)).toEqual(result);
      expect(boundary.context.measureText).toHaveBeenCalledTimes(4);
      expect(boundary.rectReads).toHaveBeenCalledTimes(2);
    } finally {
      boundary.measure.dispose();
    }
  });

  it("reuses repeated words at maximum source capacity without repeated native shaping", async () => {
    const boundary = measurementBoundary();
    try {
      const source = "word ".repeat(20_000);
      const request = {
        document: parseTextMarkdown(source, { style }),
        width: 1020,
        padding: 10,
        style,
      };
      const result = await layoutTextMarkdown(request, {
        measure: boundary.measure,
        scheduler: createTestWorkScheduler(),
      });
      expect(result.layout.lines.length).toBe(1000);
      expect(result.layout).toMatchObject({ padding: 10 });
      expect(result.layout.lines[0]).toMatchObject({ x: 10, y: 10 });
      expect(boundary.context.measureText).toHaveBeenCalledTimes(3);
      expect(boundary.createElement).toHaveBeenCalledTimes(1);
      expect(boundary.createElementNS).toHaveBeenCalledTimes(3);
      expect(boundary.createTextNode).toHaveBeenCalledTimes(1);
      expect(boundary.rectReads).toHaveBeenCalledTimes(2);
      expect(boundary.styleWrites).toHaveBeenCalledTimes(2);
      expect(result.layout.lines.flatMap((line) => line.runs).length).toBe(1000);
      const repeated = await layoutTextMarkdown(request, {
        measure: boundary.measure,
        scheduler: createTestWorkScheduler(),
      });
      expect(repeated).toEqual(result);
      expect(boundary.context.measureText).toHaveBeenCalledTimes(3);
      expect(boundary.rectReads).toHaveBeenCalledTimes(2);
      expect(boundary.styleWrites).toHaveBeenCalledTimes(2);
    } finally {
      boundary.measure.dispose();
    }
  });

  it("evicts bounded measurement entries, distinguishes font variants and releases the native canvas", () => {
    const boundary = measurementBoundary();
    for (let index = 0; index < 2049; index += 1) boundary.measure.measure(`word-${index}`, style);
    boundary.measure.measure("word-2048", style);
    expect(boundary.context.measureText).toHaveBeenCalledTimes(2049);
    boundary.measure.measure("word-0", style);
    expect(boundary.context.measureText).toHaveBeenCalledTimes(2050);
    boundary.measure.measure("word-0", { ...style, bold: true });
    expect(boundary.context.font).toContain("700");
    expect(boundary.context.measureText).toHaveBeenCalledTimes(2051);
    boundary.measure.clear();
    boundary.measure.measure("word-0", style);
    expect(boundary.context.measureText).toHaveBeenCalledTimes(2052);
    expect(boundary.rectReads).toHaveBeenCalledTimes(6);
    expect(boundary.styleWrites).toHaveBeenCalledTimes(6);
    expect(boundary.nativeDocument.body.childNodes).toHaveLength(1);
    expect(boundary.nativeDocument.head.querySelectorAll("style")).toHaveLength(1);
    boundary.measure.dispose();
    expect(boundary.canvas).toMatchObject({ width: 0, height: 0 });
    expect(() => boundary.measure.measure("word-0", style)).toThrow("disposed");
    expect(boundary.nativeDocument.body.childNodes).toHaveLength(0);
    expect(boundary.nativeDocument.head.querySelectorAll("style")).toHaveLength(0);
  });
});

describe("native CSS line-box reuse", () => {
  it("matches the native unitless line-height over a 3,000-line field without pixel-value rounding drift", async () => {
    const boundary = measurementBoundary(undefined, undefined, (_font, _fontSize, lineHeight) => ({
      ascent: 24,
      lineHeight: lineHeight === "1.3" ? 31.1875 : 31.203125,
    }));
    const baseStyle = { ...style, fontSize: 24 };
    const request = {
      document: parseTextMarkdown(Array.from({ length: 3000 }, () => "Line").join("\n"), {
        style: baseStyle,
      }),
      width: 400,
      style: baseStyle,
    };
    try {
      const result = await layoutTextMarkdown(request, {
        measure: boundary.measure,
        scheduler: createTestWorkScheduler(),
      });
      expect(result.layout.lines).toHaveLength(3000);
      expect(result.height).toBe(93_562.5);
      expect(result.layout.lines[2999]!.y).toBe(93_531.313);
      expect(boundary.styleWrites).toHaveBeenCalledWith("line-height", "1.3");
      expect(
        boundary.nativeDocument.body.querySelector<HTMLDivElement>(".inkbook-text-line-probe")!
          .style.lineHeight,
      ).toBe("1.3");
      expect(boundary.rectReads).toHaveBeenCalledTimes(2);
    } finally {
      boundary.measure.dispose();
    }
  });

  it("uses native heading baselines instead of quantized Canvas bounds and retains subpixel row advances", async () => {
    const faceId = "b".repeat(64);
    const boundary = measurementBoundary(
      () => faceId,
      undefined,
      (_font, fontSize) => ({
        ascent: fontSize,
        lineHeight: Math.floor(fontSize * 1.3 * 64) / 64,
      }),
    );
    boundary.context.measureText.mockImplementation((text) => ({
      width: text.length * 10,
      fontBoundingBoxAscent: 47,
      fontBoundingBoxDescent: 12,
    }));
    const baseStyle = { ...style, fontSize: 24 };
    const request = {
      document: parseTextMarkdown("# Heading\n# Heading\n# Heading", { style: baseStyle }),
      width: 300,
      style: baseStyle,
    };
    try {
      const result = await layoutTextMarkdown(request, {
        measure: boundary.measure,
        scheduler: createTestWorkScheduler(),
      });
      expect(result.layout.lines.map((line) => line.baseline)).toEqual([48, 48, 48]);
      expect(result.layout.lines.map((line) => line.height)).toEqual([62.391, 62.391, 62.391]);
      expect(result.layout.lines.map((line) => line.y)).toEqual([0, 62.391, 124.781]);
      expect(result.height).toBe(187.172);
      expect(result.layout.lines.every((line) => line.width === 70)).toBe(true);
      expect(boundary.rectReads).toHaveBeenCalledTimes(2);
      expect(boundary.styleWrites).toHaveBeenCalledTimes(2);
      expect(boundary.createElementNS).toHaveBeenCalledTimes(3);
    } finally {
      boundary.measure.dispose();
    }
  });

  it("bounds native font metric cache retention independently of per-word widths", () => {
    const boundary = measurementBoundary();
    try {
      for (let fontSize = 20; fontSize <= 276; fontSize += 1)
        boundary.measure.measure("first", { ...style, fontSize });
      expect(boundary.rectReads).toHaveBeenCalledTimes(514);
      boundary.measure.measure("second", { ...style, fontSize: 276 });
      expect(boundary.rectReads).toHaveBeenCalledTimes(514);
      boundary.measure.measure("second", style);
      expect(boundary.rectReads).toHaveBeenCalledTimes(516);
      expect(boundary.createElementNS).toHaveBeenCalledTimes(3);
    } finally {
      boundary.measure.dispose();
    }
  });
});

describe("bounded mathematical syntax fallback", () => {
  it("reuses the normal-text work bounds for a long literal expression and stops cancelled preparation", async () => {
    const source = `$${String.fromCharCode(92)}frac{${"a".repeat(7800)}}{$`;
    const resolveFont = vi.fn<TextFontResourceResolver>((font) =>
      (font.fontFamily === "jetbrains-mono" ? "b" : "a").repeat(64),
    );
    const visits = vi.fn<TextFontResourceBoundaries>(() => []);
    const normalVisits = vi.fn<TextFontResourceBoundaries>(() => []);
    const boundary = measurementBoundary(resolveFont, visits);
    const normal = measurementBoundary(resolveFont, normalVisits);
    const scheduler = createTestWorkScheduler();
    const request = {
      document: parseTextMarkdown(source, { style }),
      width: 400,
      style,
      baseFontResourceId: "a".repeat(64),
    };
    const math = {
      resolve: vi.fn(async () => {
        throw new TextMathSyntaxError("MissingCloseBrace");
      }),
    };
    try {
      await layoutTextMarkdown(
        { document: parseTextMarkdown(`\`${source}\``, { style }), width: 400, style },
        { measure: normal.measure, scheduler },
      );
      const result = await layoutTextMarkdown(request, {
        measure: boundary.measure,
        scheduler,
        math,
      });
      expect(request.document.source).toBe(source);
      expect(
        result.layout.lines
          .flatMap((line) => line.runs)
          .map((run) => run.text)
          .join(""),
      ).toBe(source);
      expect(result.layout.math).toHaveLength(0);
      expect(math.resolve).toHaveBeenCalledOnce();
      expect(
        Math.max(...boundary.context.measureText.mock.calls.map(([text]) => text.length)),
      ).toBeLessThanOrEqual(256);
      expect(boundary.context.measureText.mock.calls.length).toBeLessThanOrEqual(
        normal.context.measureText.mock.calls.length,
      );
      expect(visits).toHaveBeenCalledTimes(normalVisits.mock.calls.length);
      expect(visits).toHaveBeenCalledTimes(Math.ceil(source.length / 256));
      expect(boundary.rectReads.mock.calls.length).toBe(normal.rectReads.mock.calls.length + 2);
      const reads = boundary.context.measureText.mock.calls.length;
      const fontReads = resolveFont.mock.calls.length;
      const queried = visits.mock.calls.length;
      const abort = new AbortController();
      const reason = new Error("Obsolete literal source.");
      visits.mockImplementationOnce(() => {
        abort.abort(reason);
        return [];
      });
      await expect(
        layoutTextMarkdown(request, {
          measure: boundary.measure,
          scheduler,
          math,
          signal: abort.signal,
        }),
      ).rejects.toBe(reason);
      expect(visits).toHaveBeenCalledTimes(queried + 1);
      expect(boundary.context.measureText).toHaveBeenCalledTimes(reads);
      expect(resolveFont).toHaveBeenCalledTimes(fontReads);
    } finally {
      boundary.measure.dispose();
      normal.measure.dispose();
    }
  });
});
