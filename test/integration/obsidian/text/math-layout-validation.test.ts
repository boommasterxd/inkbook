// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  loadMathJax: async () => undefined,
  finishRenderMath: async () => undefined,
  renderMath: () => document.createElement("mjx-container"),
}));

import type { FontResourceV2 } from "../../../../src/domain/schema/public";
import { validateRuntimeInkElementV1 } from "../../../../src/domain/schema/element-validation";
import { validateRuntimeInkSnapshotV1 } from "../../../../src/domain/schema/snapshot-validation";
import { preserveTextReflowOrigin } from "../../../../src/domain/geometry/text-reflow";
import { loadBuiltinFont } from "../../../../src/persistence/fonts/builtin-fonts";
import { PortableMathRenderer } from "../../../../src/obsidian/text/portable-math-renderer";
import { ObsidianTextMathRenderer } from "../../../../src/obsidian/text/math-renderer";
import { layoutTextMarkdown } from "../../../../src/rendering/text/text-layout";
import type { TextMathResolver } from "../../../../src/rendering/text/text-layout-types";
import { TextMathSyntaxError } from "../../../../src/rendering/text/text-math-syntax-error";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { createWorkerSnapshot } from "../../../fixtures/persistence/worker-snapshot";
import { textElement } from "../../../fixtures/rendering/text";
import { parseTextMarkdown } from "../../../fixtures/domain/text-source";

const scheduler = createTestWorkScheduler();
let fonts: FontResourceV2[];
beforeAll(async () => {
  fonts = await Promise.all([
    loadBuiltinFont("inter", 400, "normal", scheduler),
    loadBuiltinFont("jetbrains-mono", 400, "normal", scheduler),
  ]);
});

async function prepareSource(source: string, math: TextMathResolver, signal?: AbortSignal) {
  const element = textElement({ source, width: 400 });
  const result = await layoutTextMarkdown(
    {
      document: parseTextMarkdown(source, element),
      width: element.width,
      style: element.style,
      baseFontResourceId: fonts[0]!.id,
    },
    {
      math,
      scheduler,
      ...(signal ? { signal } : {}),
      measure: {
        resolveFontResourceId: (style) => fonts[style.fontFamily === "jetbrains-mono" ? 1 : 0]!.id,
        measure: (text, style, fontResourceId) => ({
          width: text.length * style.fontSize * 0.5,
          ascent: style.fontSize * 0.95,
          descent: style.fontSize * 0.35,
          lineHeight: style.fontSize * 1.3,
          ...(fontResourceId === undefined ? {} : { fontResourceId }),
        }),
      },
    },
  );
  return preserveTextReflowOrigin(element, {
    ...element,
    layout: result.layout,
    height: result.height,
  });
}

describe("portable math source and strict runtime validation", () => {
  it.each([
    { engine: "portable", words: "a b", expectedPaths: 2 },
    { engine: "portable", words: "long text ".repeat(60), expectedPaths: 480 },
    { engine: "public CHTML fallback", words: "a b", expectedPaths: 2 },
    { engine: "public CHTML fallback", words: "long text ".repeat(60), expectedPaths: 480 },
  ])(
    "keeps spaced text math valid through $engine ($expectedPaths drawn paths)",
    async ({ engine, words, expectedPaths }) => {
      const source = `$${String.fromCharCode(92)}text{${words}}$`;
      const math =
        engine === "portable"
          ? new PortableMathRenderer(scheduler)
          : new ObsidianTextMathRenderer(scheduler);
      try {
        const prepared = await prepareSource(source, math);
        expect(prepared.source).toBe(source);
        expect(prepared.layout.math).toHaveLength(1);
        expect(prepared.layout.math![0]!.paths).toHaveLength(expectedPaths);
        expect(prepared.layout.math![0]!.paths.every((path) => path.d.length > 0)).toBe(true);
        expect(prepared.layout.math![0]!.width).toBeLessThanOrEqual(400);
        if (words === "a b") {
          const compact = await math.resolve(
            `${String.fromCharCode(92)}text{ab}`,
            false,
            24,
            undefined,
            400,
          );
          expect(prepared.layout.math![0]!.width).toBeGreaterThan(compact.width);
        }
        expect(validateRuntimeInkElementV1(prepared).ok).toBe(true);
        expect(
          validateRuntimeInkSnapshotV1({
            ...createWorkerSnapshot([prepared]),
            version: 2,
            fontResources: fonts,
          }).ok,
        ).toBe(true);
      } finally {
        math.dispose();
      }
    },
  );
});

describe("recoverable mathematical source", () => {
  it.each(["portable", "public fallback"])(
    "keeps invalid TeX as editable literal source through %s and permits repair",
    async (engine) => {
      const math =
        engine === "portable"
          ? new PortableMathRenderer(scheduler)
          : new ObsidianTextMathRenderer(scheduler);
      const literal = `$${String.fromCharCode(92)}frac{a}{$`;
      const source = `Before $x$.\nUngültige Formel ${literal}\nAfter $y$.`;
      try {
        const prepared = await prepareSource(source, math);
        expect(prepared.source).toBe(source);
        expect(prepared.layout.math).toHaveLength(2);
        const fallback = prepared.layout.lines
          .flatMap((line) => line.runs)
          .find((run) => run.text === literal)!;
        expect(fallback).toMatchObject({
          start: source.indexOf(literal),
          end: source.indexOf(literal) + literal.length,
          fontResourceId: fonts[1]!.id,
        });
        expect(fallback.style?.fontFamily).toBe("jetbrains-mono");
        expect(validateRuntimeInkElementV1(prepared).ok).toBe(true);
        expect(
          validateRuntimeInkSnapshotV1({
            ...createWorkerSnapshot([prepared]),
            version: 2,
            fontResources: fonts,
          }).ok,
        ).toBe(true);
        const repaired = await prepareSource(source.replace("frac{a}{", "frac{a}{b}"), math);
        expect(repaired.layout.math).toHaveLength(3);
        expect(
          repaired.layout.lines
            .flatMap((line) => line.runs)
            .some((run) => run.style?.fontFamily === "jetbrains-mono"),
        ).toBe(false);
      } finally {
        math.dispose();
      }
    },
  );

  it("retains display delimiters and newlines when a display formula has invalid syntax", async () => {
    const math = new PortableMathRenderer(scheduler);
    const source = `$$\n${String.fromCharCode(92)}frac{a}{\n$$`;
    try {
      const prepared = await prepareSource(source, math);
      expect(prepared.source).toBe(source);
      expect(prepared.layout.math).toHaveLength(0);
      expect(
        prepared.layout.lines.map((line) => line.runs.map((run) => run.text).join("")).join("\n"),
      ).toBe(source);
      expect(validateRuntimeInkElementV1(prepared).ok).toBe(true);
    } finally {
      math.dispose();
    }
  });

  it.each(["\\def\\a{\\a}\\a", '\\mmlToken{mi}[onclick="unsafe"]{x}', "\\text{🙂}"])(
    "does not turn resource, attribute-policy or normalization failures into literal output: %s",
    async (latex) => {
      const math = new PortableMathRenderer(scheduler);
      try {
        await expect(prepareSource(`$${latex}$`, math)).rejects.not.toBeInstanceOf(
          TextMathSyntaxError,
        );
      } finally {
        math.dispose();
      }
    },
  );

  it("preserves cancellation when a stale formula also reports invalid syntax", async () => {
    const abort = new AbortController();
    const reason = new Error("Obsolete source.");
    const math: TextMathResolver = {
      resolve: async () => {
        abort.abort(reason);
        throw new TextMathSyntaxError("MissingCloseBrace");
      },
    };
    await expect(prepareSource("$broken$", math, abort.signal)).rejects.toBe(reason);
  });
});
