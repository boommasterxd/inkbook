import { expect, it } from "vitest";
import { textElement } from "../../domain/schema/fixtures";
import { loadBuiltinFont } from "../../../../src/persistence/fonts/builtin-fonts";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/document-codec";
import { ChunkedInkbookInputParser } from "../../../../src/persistence/serialization/input/chunked-input-codec";
import { StreamingStaticIntegrityMatcher } from "../../../../src/persistence/serialization/input/streaming-static-integrity";
import { serializeTextMarkupFragments } from "../../../../src/persistence/serialization/output/text-markup";
import { createSnapshot } from "./fixtures";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";

async function fixture(inline = false, rotation = 15) {
  const element = textElement();
  element.style.fontFamily = "inter";
  element.backgroundColor = { type: "theme-text" };
  element.backgroundOpacity = 0.7;
  element.rotation = rotation;
  if (inline) {
    element.ranges = [
      {
        start: 0,
        end: 2,
        style: { backgroundColor: { type: "rgba", value: "#113399FF" }, backgroundOpacity: 0.125 },
      },
      { start: 2, end: 5, style: { backgroundColor: null } },
    ];
    element.layout.lines[0]!.runs = [
      { text: "He", start: 0, end: 2, x: 0, width: 20, style: element.ranges[0]!.style },
      { text: "llo", start: 2, end: 5, x: 20, width: 20, style: element.ranges[1]!.style },
    ];
  }
  const font = await loadBuiltinFont("inter", 400, "normal", new TestWorkScheduler());
  const saved = serializeInkbookDocument({
    ...createSnapshot([element]),
    version: 2,
    fontResources: [font],
  });
  if (!saved.ok) throw new Error(saved.error.message);
  const background = [...serializeTextMarkupFragments(element, true)].find(
    (fragment) => fragment.legacyTexts !== undefined,
  )!;
  return { ...saved.value, background };
}

function expectBackgroundChunks(
  saved: Awaited<ReturnType<typeof fixture>>,
  variant: string,
  rewrite: boolean | null,
): string {
  const svg = saved.svg.replace(saved.background.text, variant);
  const suffix = svg.slice(svg.indexOf("</metadata>") + "</metadata>".length);
  for (const size of [1, 31, suffix.length]) {
    const matcher = new StreamingStaticIntegrityMatcher(saved.snapshot, saved.lockedHeight);
    let valid = true;
    for (let offset = 0; offset < suffix.length && valid; offset += size)
      valid = matcher.write(suffix.slice(offset, offset + size));
    expect(valid && matcher.finish()).toBe(rewrite !== null);
    if (rewrite !== null) expect(matcher.requiresCanonicalRewrite).toBe(rewrite);
  }
  return svg;
}

it.each([false, true])(
  "migrates exact radius-two, square and partitioned V2 backgrounds (inline: %s)",
  async (inline) => {
    const saved = await fixture(inline);
    const { background } = saved;
    const variants = [background.text, ...background.legacyTexts!];
    expect(new Set(variants).size).toBe(inline ? 4 : 3);
    for (const variant of variants) {
      const rewrite = variant !== background.text;
      const svg = expectBackgroundChunks(saved, variant, rewrite);
      const input = new ChunkedInkbookInputParser({ staticValidation: "canonical" });
      expect((await input.write(new TextEncoder().encode(svg))).ok).toBe(true);
      const parsed = await input.finish();
      expect(parsed).toMatchObject({ ok: true, value: { requiresCanonicalRewrite: rewrite } });
      if (parsed.ok)
        expect(serializeInkbookDocument(parsed.value.snapshot)).toMatchObject({
          ok: true,
          value: { svg: saved.svg },
        });
    }
  },
);

it("accepts the exact previous square background and rejects altered geometry", async () => {
  const saved = await fixture(false, 0);
  const oldPath = "M100 100L200 100L200 150L100 150Z";
  const oldSvg = saved.svg.replace(/(<g id="inkbook-content"><path d=")[^"]+/u, `$1${oldPath}`);
  expect(oldSvg).toBe(saved.svg.replace(saved.background.text, saved.background.legacyTexts![1]));
  const tampered = oldSvg.replace(oldPath, "M100 100L201 100L200 150L100 150Z");
  const input = new ChunkedInkbookInputParser({ staticValidation: "canonical" });
  const written = await input.write(new TextEncoder().encode(tampered));
  const rejected = written.ok ? await input.finish() : written;
  expect(rejected).toMatchObject({ ok: false, error: { code: "static-path-mismatch" } });
});

it("rejects arbitrary radii and mixtures of separately valid background fragments", async () => {
  const saved = await fixture(true);
  const { background } = saved;
  const firstCanonicalPath = background.text.match(/<path[^>]+\/>/u)![0];
  const firstLegacyPath = background.legacyTexts![0].match(/<path[^>]+\/>/u)![0];
  const mixed = background.text.replace(firstCanonicalPath, firstLegacyPath);
  const tampered = background.legacyTexts![0].replace(/A2 2/gu, "A3 3");
  expect(mixed).not.toBe(background.text);
  expect(tampered).not.toBe(background.legacyTexts![0]);
  for (const variant of [mixed, tampered]) {
    const svg = expectBackgroundChunks(saved, variant, null);
    const input = new ChunkedInkbookInputParser({ staticValidation: "canonical" });
    const written = await input.write(new TextEncoder().encode(svg));
    expect(written.ok ? await input.finish() : written).toMatchObject({
      ok: false,
      error: { code: "static-path-mismatch" },
    });
  }
});
