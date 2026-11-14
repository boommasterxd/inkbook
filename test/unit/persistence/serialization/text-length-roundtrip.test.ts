import { expect, it } from "vitest";
import { textElement } from "../../domain/schema/fixtures";
import { loadBuiltinFont } from "../../../../src/persistence/fonts/builtin-fonts";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/document-codec";
import { ChunkedInkbookInputParser } from "../../../../src/persistence/serialization/input/chunked-input-codec";
import { StreamingStaticIntegrityMatcher } from "../../../../src/persistence/serialization/input/streaming-static-integrity";
import { inspectTrustedSvgOutput } from "../../../../src/persistence/scheduling/trusted-svg-output";
import { createSnapshot, inlineFormulaLayout } from "./fixtures";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";

async function fixture(source = "Hello", text = source, width = 40) {
  const font = await loadBuiltinFont("inter", 400, "normal", new TestWorkScheduler());
  const element = textElement();
  element.source = source;
  element.style.fontFamily = "inter";
  element.layout.lines[0]!.width = width;
  element.layout.lines[0]!.runs = [{ text, start: 0, end: source.length, x: 0, width }];
  if (source === "$x$") element.layout.math = inlineFormulaLayout();
  const saved = serializeInkbookDocument({
    ...createSnapshot([element]),
    version: 2,
    fontResources: [font],
  });
  if (!saved.ok) throw new Error(saved.error.message);
  return saved.value;
}

async function parse(input: string, mode: "canonical" | "safe" | "proof") {
  const proof =
    mode === "proof" ? (await inspectTrustedSvgOutput(input)).safeStaticProof : undefined;
  const parser = new ChunkedInkbookInputParser({
    staticValidation: mode === "canonical" ? "canonical" : "safe",
    ...(proof === undefined ? {} : { safeStaticProof: proof }),
  });
  const written = await parser.write(new TextEncoder().encode(input));
  return written.ok ? parser.finish() : written;
}

it("binds positive SVG advances to stored run widths and migrates older bound V2 graphics", async () => {
  const saved = await fixture();
  expect(saved.svg).toContain(' textLength="40" lengthAdjust="spacingAndGlyphs">Hello</tspan>');
  const legacy = saved.svg.replaceAll(/ textLength="[^"]+" lengthAdjust="spacingAndGlyphs"/gu, "");
  for (const mode of ["canonical", "safe", "proof"] as const) {
    expect(await parse(saved.svg, mode)).toMatchObject({
      ok: true,
      value: { requiresCanonicalRewrite: false, snapshot: saved.snapshot },
    });
    const old = await parse(legacy, mode);
    expect(old).toMatchObject({
      ok: true,
      value: { requiresCanonicalRewrite: true, snapshot: saved.snapshot },
    });
    if (old.ok && "snapshot" in old.value)
      expect(serializeInkbookDocument(old.value.snapshot)).toMatchObject({
        ok: true,
        value: { svg: saved.svg },
      });
  }
  expect(
    await parse(saved.svg.replace('textLength="40"', 'textLength="41"'), "canonical"),
  ).toMatchObject({ ok: false, error: { code: "static-path-mismatch" } });
});

it.each([
  { source: "", text: "", width: 0 },
  { source: "\u200b", text: "\u200b", width: 0 },
  { source: "$x$", text: "", width: 40 },
])(
  "omits advance attributes without repeated rewrite for $source",
  async ({ source, text, width }) => {
    const saved = await fixture(source, text, width);
    expect(saved.svg).not.toContain(" textLength=");
    expect(saved.svg).not.toContain(" lengthAdjust=");
    for (const mode of ["canonical", "safe", "proof"] as const)
      expect(await parse(saved.svg, mode)).toMatchObject({
        ok: true,
        value: { requiresCanonicalRewrite: false },
      });
  },
);

it("recognizes only the exact legacy attribute omission across byte-sized static chunks", async () => {
  const saved = await fixture();
  for (const legacy of [false, true]) {
    const svg = legacy
      ? saved.svg.replaceAll(/ textLength="[^"]+" lengthAdjust="spacingAndGlyphs"/gu, "")
      : saved.svg;
    const suffix = svg.slice(svg.indexOf("</metadata>") + "</metadata>".length);
    const matcher = new StreamingStaticIntegrityMatcher(saved.snapshot, saved.lockedHeight);
    for (const character of suffix) expect(matcher.write(character)).toBe(true);
    expect(matcher.finish()).toBe(true);
    expect(matcher.requiresCanonicalRewrite).toBe(legacy);
  }
});
