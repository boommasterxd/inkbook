import { describe, expect, it, vi } from "vitest";
import { validateTextElementSteps } from "../../../../src/persistence/documents/safe-svg-text";
import * as metadataDecoder from "../../../../src/persistence/documents/safe-svg-metadata";
import { parseOpeningTag } from "../../../../src/persistence/documents/svg-tag";
import {
  validateSafeSvg,
  validateSafeSvgSteps,
  validateEditableSafeSvgPreludeSteps,
} from "../../../../src/persistence/documents/safe-svg-validator";
import { CANONICAL_THEME_STYLESHEET } from "../../../../src/persistence/documents/svg-theme";
import { validateStaticSvgChunks } from "../../../fixtures/persistence/safe-svg";
import { StreamingSafeStaticValidator } from "../../../../src/persistence/serialization/input/streaming-safe-static";
import { consumeSerializationSteps } from "../../../../src/persistence/serialization/output/serialization-model-preparation";

const SPAN =
  '<tspan x="-12.5" y="32" font-family="inkbook-inter" font-size="24" font-weight="400" font-style="normal" text-decoration="none" fill="#222222FF" fill-opacity="1" class="inkbook-theme-fill">Ä &lt; &amp; 😀</tspan>';
const TEXT = `<text transform="rotate(30 0 0)">${SPAN}</text>`;
const FONT =
  '@font-face{font-family:"inkbook-inter";font-style:normal;font-weight:400;src:url("data:font/woff2;base64,d09GMg==") format("woff2")}';

function prefix(font = FONT, version = 2): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2048.6 100" data-inkbook-format="inkbook" data-inkbook-version="${version}" data-inkbook-revision="0" data-inkbook-snapshot-sha256="${"0".repeat(64)}"><style id="inkbook-theme">${CANONICAL_THEME_STYLESHEET}</style>${font === "" ? "" : `<style id="inkbook-fonts">${font}</style>`}<metadata id="inkbook-snapshot" data-encoding="json">`;
}

function suffix(content = TEXT): string {
  return `<g id="inkbook-background"></g><g id="inkbook-highlights"></g><g id="inkbook-content">${content}</g></svg>`;
}

function svg(content = TEXT, font = FONT, version = 2): string {
  return prefix(font, version) + "{}</metadata>" + suffix(content);
}

function exhaust<T>(steps: Generator<void, T>): { result: T; yields: number } {
  let step = steps.next();
  let yields = 0;
  while (!step.done) {
    yields += 1;
    step = steps.next();
  }
  return { result: step.value, yields };
}

async function streamed(content: string, chunk: number, version = 2): Promise<boolean> {
  return validateStaticSvgChunks(suffix(content), chunk, version);
}

describe("safe text SVG visitors", () => {
  it("preserves literal run whitespace with the canonical XML space attribute", async () => {
    const whitespace = "  indented\tcode  ";
    const content = TEXT.replace("<text ", '<text xml:space="preserve" ').replace(
      "Ä &lt; &amp; 😀",
      whitespace,
    );
    const text = vi.fn();
    const openedAttributes: ReadonlyMap<string, string>[] = [];
    const open = (tag: NonNullable<ReturnType<typeof parseOpeningTag>>) =>
      openedAttributes.push(tag.attributes);
    expect(
      exhaust(validateTextElementSteps(content, 0, { open, text, close: () => undefined })).result,
    ).toBe(content.length);
    expect(openedAttributes[0]?.get("xml:space")).toBe("preserve");
    expect(text).toHaveBeenCalledExactlyOnceWith(whitespace);
    expect(validateSafeSvg(svg(content))).not.toBeNull();
    expect(await streamed(content, 1)).toBe(true);
  });

  it("emits validated text and attributes with one decode per run", () => {
    const events: unknown[] = [];
    const decode = vi.spyOn(metadataDecoder, "decodeMetadataTextSteps");
    try {
      const { result } = exhaust(
        validateTextElementSteps(TEXT, 0, {
          open: (tag) =>
            events.push({ name: tag.name, attributes: Object.fromEntries(tag.attributes) }),
          text: (value) => events.push(value),
          close: () => events.push("close"),
        }),
      );
      expect(result).toBe(TEXT.length);
      expect(events).toMatchObject([
        { name: "text", attributes: { transform: "rotate(30 0 0)" } },
        {
          name: "tspan",
          attributes: { "font-family": "inkbook-inter", x: "-12.5" },
        },
        "Ä < & 😀",
        "close",
        "close",
      ]);
      expect(decode).toHaveBeenCalledTimes(1);
    } finally {
      decode.mockRestore();
    }
  });

  it("never emits unvalidated run text to its visitor", () => {
    const text = vi.fn();
    const result = exhaust(
      validateTextElementSteps(TEXT.replace("Ä &lt; &amp; 😀", "<script/>"), 0, {
        open: () => undefined,
        close: () => undefined,
        text,
      }),
    ).result;
    expect(result).toBeNull();
    expect(text).not.toHaveBeenCalled();
  });
});

describe("strict XML whitespace syntax", () => {
  it.each(["default", "", "preserve default"])("rejects unsupported xml:space=%s", (value) => {
    expect(validateSafeSvg(svg(TEXT.replace("<text ", `<text xml:space="${value}" `)))).toBeNull();
  });

  it.each([
    '<text xml:lang="en">',
    '<text xlink:href="data:x">',
    "<xml:text>",
    '<text xmlns:xml="x">',
  ])("rejects other XML namespace syntax %s", (tag) => {
    expect(parseOpeningTag(tag, 0)).toBeNull();
  });
});

describe("safe text SVG envelopes", () => {
  it("accepts embedded fonts, escaped Unicode runs, and legacy geometry", () => {
    expect(validateSafeSvg(svg())).toMatchObject({ fontStylesheet: FONT, version: 2 });
    expect(validateSafeSvg(svg("", "", 1))).toMatchObject({ version: 1 });
    expect(validateSafeSvg(svg(TEXT, "", 1))).toBeNull();
    expect(validateSafeSvg(svg("", FONT, 1))).toBeNull();
  });

  it("keeps supported future presentation fallback separate from editable versions", () => {
    expect(validateSafeSvg(svg(TEXT, FONT, 3))).toBeNull();
    expect(
      exhaust(validateSafeSvgSteps(svg(TEXT, FONT, 3), { versionPolicy: "newer" })).result,
    ).toMatchObject({ version: 3 });
  });

  it.each([1, 7, 4096])(
    "validates text across %s-character streaming boundaries",
    async (chunk) => {
      expect(await streamed(TEXT, chunk)).toBe(true);
      expect(await streamed(TEXT, chunk, 1)).toBe(false);
    },
  );

  it.each([
    TEXT.replace("<text ", '<text onclick="run()" '),
    TEXT.replace("inkbook-inter", "Arial"),
    TEXT.replace('font-size="24"', 'font-size="0"'),
    TEXT.replace('x="-12.5"', 'x="-0"'),
    TEXT.replace('class="inkbook-theme-fill"', 'style="fill:red"'),
    TEXT.replace("#222222FF", "url(https://invalid)"),
    TEXT.replace("#222222FF", "#FFFFFFFF"),
    TEXT.replace("Ä &lt; &amp; 😀", "<script>run()</script>"),
    TEXT.replace("Ä &lt; &amp; 😀", "&#65;"),
    TEXT.replace("Ä &lt; &amp; 😀", "\u0000"),
    TEXT.replace("rotate(30 0 0)", "rotate(30 0 0) scale(2)"),
    `<g opacity="0.5">${TEXT}</g>`,
  ])("rejects unsafe text in full and streamed validation", async (content) => {
    expect(validateSafeSvg(svg(content))).toBeNull();
    expect(await streamed(content, 13)).toBe(false);
  });

  it("rejects text in background and highlight bands", async () => {
    for (const band of ["background", "highlights"]) {
      const input = suffix("").replace(
        `<g id="inkbook-${band}">`,
        `<g id="inkbook-${band}">${TEXT}`,
      );
      expect(validateSafeSvg(prefix() + "{}</metadata>" + input)).toBeNull();
      const validator = new StreamingSafeStaticValidator(() => undefined);
      expect(await validator.write(input)).toBe(false);
    }
  });

  it("accepts bounded math path placement only from version 2", async () => {
    const path =
      '<path transform="rotate(-30 20 30) translate(12.5 -2)" d="M 0 0 L 1 1" fill="#222222FF"/>';
    expect(validateSafeSvg(svg(path))).not.toBeNull();
    expect(validateSafeSvg(svg(path, "", 1))).toBeNull();
    expect(await streamed(path, 5)).toBe(true);
    expect(await streamed(path.replace("translate(12.5 -2)", "translate(1000001 0)"), 5)).toBe(
      false,
    );
  });
});

describe("text layout advance attributes", () => {
  it.each([
    [TEXT, 1],
    [TEXT.replace("<tspan ", '<tspan textLength="13.25" lengthAdjust="spacingAndGlyphs" '), 0],
    [TEXT.replace("Ä &lt; &amp; 😀", ""), 0],
    [TEXT.replace("Ä &lt; &amp; 😀", "  "), 1],
  ] as const)("reports only nonempty unadjusted runs", async (content, count) => {
    expect(validateSafeSvg(svg(content))).toMatchObject({
      unadjustedTextRuns: count,
      requiresCanonicalRewrite: false,
    });
    const validator = new StreamingSafeStaticValidator(() => undefined);
    expect(await validator.write(suffix(content))).toBe(true);
    expect(validator.finish()).toBe(true);
    expect(validator.unadjustedTextRuns).toBe(count);
    expect(validator.hasUnadjustedText).toBe(count > 0);
  });

  it.each([
    'textLength="0" lengthAdjust="spacingAndGlyphs"',
    'textLength="-1" lengthAdjust="spacingAndGlyphs"',
    'textLength="1.000" lengthAdjust="spacingAndGlyphs"',
    'textLength="1e3" lengthAdjust="spacingAndGlyphs"',
    'textLength="1000001" lengthAdjust="spacingAndGlyphs"',
    'textLength="12" lengthAdjust="spacing"',
    'textLength="12"',
    'lengthAdjust="spacingAndGlyphs"',
  ])("rejects malformed or unpaired advance attributes %s", async (attributes) => {
    const content = TEXT.replace("<tspan ", `<tspan ${attributes} `);
    expect(validateSafeSvg(svg(content))).toBeNull();
    expect(await streamed(content, 7)).toBe(false);
  });
});

describe("embedded font CSS allowlist", () => {
  it("exposes safe font payloads from the validating pass for metadata rehydration", () => {
    const variableFont = FONT.replace("inkbook-inter", "inkbook-caveat")
      .replace("font-style:normal", "font-style:italic")
      .replace("font-weight:400", "font-weight:400 700");
    const css = FONT + variableFont;
    const expected = [
      { family: "inter", style: "normal", weight: 400, mimeType: "font/woff2", data: "d09GMg==" },
      {
        family: "caveat",
        style: "italic",
        weight: 400,
        weightRange: [400, 700],
        mimeType: "font/woff2",
        data: "d09GMg==",
      },
    ];
    expect(validateSafeSvg(svg(TEXT, css))?.fontFaces).toEqual(expected);
    expect(exhaust(validateEditableSafeSvgPreludeSteps(prefix(css))).result?.fontFaces).toEqual(
      expected,
    );
  });

  it.each([
    ["font/woff2", "woff2"],
    ["font/woff", "woff"],
    ["font/ttf", "truetype"],
    ["font/otf", "opentype"],
  ])("accepts %s with its canonical format", (mime, format) => {
    const font = FONT.replace("font/woff2", mime)
      .replace('format("woff2")', `format("${format}")`)
      .replace("font-weight:400", "font-weight:100 1000");
    expect(validateSafeSvg(svg(TEXT, font))).not.toBeNull();
  });

  it.each([
    FONT.replace("data:font/woff2;base64,d09GMg==", "https://invalid/font.woff2"),
    FONT.replace("font/woff2", "image/svg+xml"),
    FONT.replace("d09GMg==", "d09GMh=="),
    FONT.replace("d09GMg==", "d09G=g=="),
    FONT.replace("font-weight:400", "font-weight:700 400"),
    FONT.replace("font-weight:400", "font-weight:1001"),
    FONT + FONT,
    FONT + "svg{fill:red}",
    FONT.replace('format("woff2")', 'format("woff")'),
    FONT.replace("@font-face", "@import"),
  ])("rejects external, malformed, or extended font CSS", (font) => {
    expect(validateSafeSvg(svg(TEXT, font))).toBeNull();
  });

  it("checks large embedded fonts cooperatively in both complete and prelude validation", () => {
    const font = FONT.replace("d09GMg==", "AAAA".repeat(20_000));
    expect(exhaust(validateSafeSvgSteps(svg(TEXT, font))).yields).toBeGreaterThan(4);
    const prelude = exhaust(validateEditableSafeSvgPreludeSteps(prefix(font)));
    expect(prelude.result).toMatchObject({ version: 2 });
    expect(prelude.yields).toBeGreaterThan(4);
  });

  it("cancels font inspection at its cooperative checkpoint", async () => {
    const font = FONT.replace("d09GMg==", "AAAA".repeat(20_000));
    const controller = new AbortController();
    await expect(
      consumeSerializationSteps(validateEditableSafeSvgPreludeSteps(prefix(font)), {
        signal: controller.signal,
        checkpoint: () => {
          controller.abort();
          return undefined;
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
