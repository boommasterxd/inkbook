import { describe, expect, it, vi } from "vitest";
import * as textDecoder from "../../../../src/persistence/documents/safe-svg-metadata";
import * as patternParser from "../../../../src/persistence/documents/safe-svg-auto-patterns";
import {
  validateSafeSvg,
  validateEditableSafeSvgPreludeSteps,
} from "../../../../src/persistence/documents/safe-svg-validator";
import { exhaustValidation } from "../../../fixtures/persistence/safe-svg";
import { StreamingSafeStaticValidator } from "../../../../src/persistence/serialization/input/streaming-safe-static";
import { autoContrastSvg } from "../../../fixtures/persistence/auto-contrast-svg";
import { rasterResource } from "../../../fixtures/persistence/image-svg";
import { parseInkbookDocumentForTest } from "../../../fixtures/persistence/parse-document";
import { legacyImageDocument } from "../../../fixtures/persistence/legacy-image-svg";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/document-codec";
import { ChunkedInkbookInputParser } from "../../../../src/persistence/serialization/input/chunked-input-codec";

const unsafeChanges = [
  (svg: string) =>
    svg.replace("<feColorMatrix ", '<feImage href="https://invalid/"/><feColorMatrix '),
  (svg: string) => svg.replace('href="#inkbook-auto-underlay"', 'href="https://invalid/underlay"'),
  (svg: string) => svg.replace('filterUnits="userSpaceOnUse"', 'filterUnits="objectBoundingBox"'),
  (svg: string) => svg.replace('type="discrete" tableValues="0 1"', 'type="linear" slope="1"'),
  (svg: string) => svg.replace('fill="inherit"', 'fill="url(#unbound)"'),
  (svg: string) => svg.replace('class="inkbook-auto-fill"', 'class="inkbook-theme-fill"'),
  (svg: string) =>
    svg.replace(/href="#inkbook-auto-geometry-[^"]+"/u, 'href="#inkbook-auto-underlay"'),
  (svg: string) => svg.replace("<pattern ", '<pattern onload="bad()" '),
  (svg: string) => svg.replace(/inkbook-auto-server-filter-./u, "inkbook-auto-server-filter-z"),
  (svg: string) =>
    svg.replace(
      /(<use href="#inkbook-auto-geometry-[^"]+" fill=")([^"]+)(" stroke=")none"/u,
      (_tag, opening: string, paint: string, middle: string) =>
        `${opening}${paint}${middle}${paint}"`,
    ),
  (svg: string) => {
    const start = svg.indexOf('<g id="inkbook-content">') + '<g id="inkbook-content">'.length;
    const end = svg.lastIndexOf("</g></svg>");
    return svg.slice(0, end) + svg.slice(start, end) + svg.slice(end);
  },
];

it.each([3, 4] as const)(
  "reads genuine version %s image metadata canonically and writes version 5",
  async (version) => {
    const legacy = legacyImageDocument(version);
    const parsed = await parseInkbookDocumentForTest(legacy.bytes);
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      sourceVersion: version,
      requiresCanonicalRewrite: true,
    });
    expect(parsed.value.snapshot.version).toBe(version);
    const written = serializeInkbookDocument(parsed.value.snapshot);
    expect(written.ok, JSON.stringify(written)).toBe(true);
    if (!written.ok) return;
    expect(written.value.snapshot.version).toBe(5);
    const reopened = await parseInkbookDocumentForTest(written.value.svg);
    expect(reopened).toMatchObject({
      ok: true,
      value: { sourceVersion: 5, requiresCanonicalRewrite: false },
    });
    if (reopened.ok)
      expect(reopened.value.snapshot.elements).toEqual(parsed.value.snapshot.elements);
  },
);

it("requires an admitted contrast definition before a streaming validator accepts Auto atoms", async () => {
  const svg = autoContrastSvg();
  const validator = new StreamingSafeStaticValidator(() => undefined, 5, [rasterResource()]);
  expect(await validator.write(svg.slice(svg.indexOf("</metadata>") + 11))).toBe(false);
});

it("retains the observed static buffer peak after completed input releases its matcher", async () => {
  const svg = autoContrastSvg();
  const parser = new ChunkedInkbookInputParser({ staticValidation: "safe" });
  expect((await parser.write(new TextEncoder().encode(svg))).ok).toBe(true);
  const peak = parser.maximumRetainedStaticInputCharacters;
  expect(peak).toBeGreaterThan(svg.length - svg.indexOf("</metadata>") - 11);
  expect((await parser.finish()).ok).toBe(true);
  expect(parser.maximumRetainedStaticInputCharacters).toBe(peak);
});

describe("automatic contrast SVG round-trips", () => {
  it("round-trips one logical pressure stroke and its retained offset with bounded portable paint tiles", async () => {
    const svg = autoContrastSvg({
      stroke: { offset: { x: 200, y: 250 } },
      image: { contrast: "light" },
    });
    expect(validateSafeSvg(svg)?.version).toBe(5);
    expect(svg).not.toContain("feImage");
    const reopened = await parseInkbookDocumentForTest(svg);
    expect(reopened.ok, JSON.stringify(reopened)).toBe(true);
    if (reopened.ok) {
      expect(reopened.value.snapshot.elements).toHaveLength(2);
      expect(reopened.value.snapshot.elements[1]).toMatchObject({
        kind: "stroke",
        offset: { x: 200, y: 250 },
        style: { color: { type: "theme-text" } },
      });
    }
  });

  it.each([1, 23, 4096])(
    "validates complete Auto atoms across %s-character chunks",
    async (size) => {
      const svg = autoContrastSvg();
      const validator = new StreamingSafeStaticValidator(
        () => undefined,
        5,
        [rasterResource()],
        validateSafeSvg(svg)?.autoPaintServers,
      );
      const suffix = svg.slice(svg.indexOf("</metadata>") + 11);
      for (let start = 0; start < suffix.length; start += size)
        expect(await validator.write(suffix.slice(start, start + size))).toBe(true);
      expect(validator.finish()).toBe(true);
    },
  );
});

describe("automatic contrast SVG streaming lifecycle", () => {
  it("preserves whitespace inside a streamed Auto text atom", async () => {
    const text =
      '<text xml:space="preserve"><tspan x="10" y="20" font-family="inkbook-example" font-size="16" font-weight="400" font-style="normal" text-decoration="none" class="inkbook-auto-fill" fill="inherit" fill-opacity="1">  A &amp; B  </tspan></text>';
    const svg = autoContrastSvg().replace(/<path\b[^>]*class="inkbook-auto-fill"[^>]*\/>/u, text);
    const safe = validateSafeSvg(svg);
    expect(safe?.version).toBe(5);
    const servers = safe?.autoPaintServers;
    const decoded = vi.spyOn(textDecoder, "decodeMetadataTextSteps");
    try {
      const validator = new StreamingSafeStaticValidator(
        () => undefined,
        5,
        [rasterResource()],
        servers,
      );
      const suffix = svg.slice(svg.indexOf("</metadata>") + 11);
      for (const character of suffix) expect(await validator.write(character)).toBe(true);
      expect(validator.finish()).toBe(true);
      expect(decoded).toHaveBeenCalledWith("  A &amp; B  ");
    } finally {
      decoded.mockRestore();
    }
  });

  it("stops a cancelled tile validation without accepting a partial atom", async () => {
    const svg = autoContrastSvg({ stroke: { points: [10, 10, 0.5, 2000, 100_000, 0.5] } });
    const servers = validateSafeSvg(svg)?.autoPaintServers;
    const patterns = vi.spyOn(patternParser, "parseSafeAutoPattern");
    try {
      const validator = new StreamingSafeStaticValidator(
        () => {
          if (patterns.mock.calls.length === 2) throw new Error("cancelled");
          return undefined;
        },
        5,
        [rasterResource()],
        servers,
      );
      await expect(validator.write(svg.slice(svg.indexOf("</metadata>") + 11))).rejects.toThrow(
        "cancelled",
      );
      expect(patterns).toHaveBeenCalledTimes(2);
      expect(validator.finish()).toBe(false);
      expect(await validator.write("</g></svg>")).toBe(false);
    } finally {
      patterns.mockRestore();
    }
  });
});

describe("shared contrast server binding", () => {
  it("rejects in-registry aliases that sample a different world region", () => {
    const svg = autoContrastSvg({ stroke: { points: [10, 10, 0.5, 20, 5000, 0.5] } });
    const references = [...svg.matchAll(/href="#(inkbook-auto-server-paint-[0-9a-f]{64})"/gu)];
    expect(references.length).toBeGreaterThanOrEqual(2);
    const first = references[0]![1]!;
    const second = references[1]![1]!;
    const changed = svg.replace(
      /href="#(inkbook-auto-server-paint-[0-9a-f]{64})"/gu,
      (tag, id: string) => {
        if (id === first) return `href="#${second}"`;
        return id === second ? `href="#${first}"` : tag;
      },
    );
    expect(validateSafeSvg(changed)).toBeNull();
  });

  it("binds registry order through the existing canonical atom pass", async () => {
    const svg = autoContrastSvg({ stroke: { points: [10, 10, 0.5, 20, 5000, 0.5] } });
    const start = svg.indexOf('<defs id="inkbook-auto-paints">');
    const end = svg.indexOf("</defs>", start);
    const pairs = [...svg.slice(start, end).matchAll(/<filter\b[\s\S]*?<\/pattern>/gu)].map(
      (entry) => entry[0],
    );
    expect(pairs.length).toBeGreaterThanOrEqual(2);
    const changed = svg.replace(pairs.join(""), [pairs[1], pairs[0], ...pairs.slice(2)].join(""));
    expect(validateSafeSvg(changed)?.version).toBe(5);
    expect(await parseInkbookDocumentForTest(changed)).toMatchObject({
      ok: false,
      error: { code: "static-path-mismatch" },
    });
  });

  it("keeps prefix admission provisional and rejects unused servers before completion", async () => {
    const svg = autoContrastSvg();
    const extra = autoContrastSvg({ stroke: { offset: { x: 100, y: 100 } } });
    const pair = /<filter\b[\s\S]*?<\/pattern>/u.exec(extra)![0];
    const end = svg.indexOf("</defs>", svg.indexOf('<defs id="inkbook-auto-paints">'));
    const changed = svg.slice(0, end) + pair + svg.slice(end);
    expect(validateSafeSvg(changed)).toBeNull();
    const prefix = changed.slice(0, changed.indexOf(">", changed.indexOf("<metadata")) + 1);
    const prelude = exhaustValidation(validateEditableSafeSvgPreludeSteps(prefix)).result;
    expect(prelude?.autoPaintServers?.size).toBe(2);
    const validator = new StreamingSafeStaticValidator(
      () => undefined,
      5,
      [rasterResource()],
      prelude?.autoPaintServers,
    );
    expect(await validator.write(changed.slice(changed.indexOf("</metadata>") + 11))).toBe(true);
    expect(validator.finish()).toBe(false);
  });
});

describe("automatic contrast SVG trust boundaries", () => {
  it.each(unsafeChanges)(
    "rejects changed references or an altered filter program",
    async (change) => {
      const svg = change(autoContrastSvg());
      expect(validateSafeSvg(svg)).toBeNull();
      expect((await parseInkbookDocumentForTest(svg)).ok).toBe(false);
    },
  );

  it("binds a safe contrast source to the authoritative image metadata", async () => {
    const svg = autoContrastSvg({ image: { contrast: "light" } });
    const changed = svg.replace(
      'fill="#FFFFFFFF"/></svg></g></svg></defs>',
      'fill="#000000FF"/></svg></g></svg></defs>',
    );
    expect(changed).not.toBe(svg);
    expect(validateSafeSvg(changed)?.version).toBe(5);
    expect(await parseInkbookDocumentForTest(changed)).toMatchObject({
      ok: false,
      error: { code: "static-path-mismatch" },
    });
  });
});
