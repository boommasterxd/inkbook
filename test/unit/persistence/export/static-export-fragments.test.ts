import { describe, expect, it, vi } from "vitest";
import { prepareStaticExportFragments } from "../../../../src/persistence/export/static-export-fragments";
import { serializeSvgEnvelope } from "../../../../src/persistence/documents/svg-envelope";
import { validateSafeSvg } from "../../../../src/persistence/documents/safe-svg-validator";
import { DOCUMENT_THEME_FALLBACK } from "../../../../src/persistence/documents/svg-theme";
import { createWorkerSnapshot } from "../../../fixtures/persistence/worker-snapshot";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";

const workScheduler = createTestWorkScheduler();

function svg(content: string[], background: string[] = [], highlights: string[] = []) {
  return serializeSvgEnvelope(createWorkerSnapshot([]), 1000, { background, content, highlights });
}

function path(d: string, paint = 'fill="none" stroke="#112233FF" stroke-width="2"') {
  return `<path d="${d}" ${paint}/>`;
}

it("emits embedded font resources and decoded text once while retaining conservative glyph bounds", async () => {
  const stylesheet =
    '@font-face{font-family:"inkbook-example";font-style:normal;font-weight:400;src:url("data:font/woff2;base64,AA==") format("woff2")}';
  const text =
    '<text transform="rotate(45 10 20)"><tspan x="10" y="20" font-family="inkbook-example" font-size="16" font-weight="400" font-style="normal" text-decoration="underline" fill="#112233FF" fill-opacity="1">Résumé &amp; &lt;math&gt;</tspan></text>';
  const input = svg([text])
    .replace('data-inkbook-version="1"', 'data-inkbook-version="2"')
    .replace("<metadata ", `<style id="inkbook-fonts">${stylesheet}</style><metadata `);
  const values: string[] = [];
  const tags: string[] = [];
  const close = vi.fn();
  expect(validateSafeSvg(input)).not.toBeNull();
  expect(
    await prepareStaticExportFragments(input, {
      workScheduler,
      visitor: { open: (tag) => tags.push(tag.name), close, text: (value) => values.push(value) },
    }),
  ).toEqual([{ minY: -Infinity, maxY: Infinity, background: false }]);
  expect(values).toEqual([stylesheet, "Résumé & <math>"]);
  expect(tags).toEqual(["svg", "style", "g", "g", "g", "text", "tspan"]);
  expect(close).toHaveBeenCalledTimes(tags.length);
  for (const damaged of [
    input.replace("<text ", '<text onclick="unexpected()" '),
    input.replace("data:font/woff2;base64,AA==", "https://unexpected.invalid/font"),
  ]) {
    expect(await prepareStaticExportFragments(damaged, { workScheduler })).toBeUndefined();
  }
});

it("includes native math-path translations and retains rotated paths without unproven clipping bounds", async () => {
  const input = svg([
    '<path d="M0 10L20 30" fill="#112233FF" transform="translate(10 100)"/>',
    '<path d="M0 10L20 30" fill="#112233FF" transform="rotate(45 10 20) translate(10 100)"/>',
  ]).replace('data-inkbook-version="1"', 'data-inkbook-version="2"');
  expect(validateSafeSvg(input)).not.toBeNull();
  expect(await prepareStaticExportFragments(input, { workScheduler })).toEqual([
    { minY: 110, maxY: 130, background: false },
    { minY: -Infinity, maxY: Infinity, background: false },
  ]);
});

describe("static SVG export fragment bounds", () => {
  it.each([
    ["M0 10 L20 30", 6, 34],
    ["M10 20l-1-5-2-3", 8, 24],
    ["M0 10 H20 h-10 V30 v-5", 6, 34],
    ["M0 10 Q10 100 20 30", 6, 104],
    ["M0 10q10-40 20 20", -34, 34],
    ["M0 10 C10-100 20 200 30 20", -104, 204],
    ["M0 10 L20 30 Z M50 100 L60 90 Z", 6, 104],
  ])("bounds actual static commands, including control hulls: %s", async (data, minY, maxY) => {
    expect(await prepareStaticExportFragments(svg([path(data)]), { workScheduler })).toEqual([
      { minY, maxY, background: false },
    ]);
  });

  it("retains band order and one ordinal per opacity or translated group", async () => {
    const input = svg(
      [
        `<g opacity="1">${path("M0 200 L10 220")}</g>`,
        `<g opacity="0.4" transform="translate(100 -50)">${path("M0 300 L10 310")}</g>`,
        `<g transform="translate(-10 20)">${path("M0 400 L10 405")}</g>`,
      ],
      [path("M0 800 L10 900")],
      [`<g opacity="0.5">${path("M0 100 L10 110")}</g>`],
    );
    expect(await prepareStaticExportFragments(input, { workScheduler })).toEqual([
      { minY: 796, maxY: 904, background: true },
      { minY: 96, maxY: 114, background: false },
      { minY: 196, maxY: 224, background: false },
      { minY: 246, maxY: 264, background: false },
      { minY: 416, maxY: 429, background: false },
    ]);
  });

  it("covers SVG miter joins and square caps beyond centerline endpoints", async () => {
    const input = svg([
      path("M0 10 L1 30 L2 10", 'stroke="#112233FF" stroke-width="20"'),
      path("M0 100 L1 101", 'stroke="#112233FF" stroke-width="10" stroke-linecap="square"'),
      path("M0 200 L10 210 Z", 'fill="#112233FF" stroke="none"'),
    ]);
    expect(await prepareStaticExportFragments(input, { workScheduler })).toEqual([
      { minY: -30, maxY: 70, background: false },
      { minY: 80, maxY: 121, background: false },
      { minY: 200, maxY: 210, background: false },
    ]);
  });

  it("does not derive visible bounds from editable metadata", async () => {
    // The envelope has an empty editable snapshot while its separately safe graphic has ink.
    expect(
      await prepareStaticExportFragments(svg([path("M0 750 L10 800")]), { workScheduler }),
    ).toEqual([{ minY: 746, maxY: 804, background: false }]);
    expect(await prepareStaticExportFragments(svg([]), { workScheduler })).toEqual([]);
  });

  it("retains non-scaling guides in the content band at every print scale", async () => {
    const input = svg([
      path(
        "M0 102 L10 102",
        `class="inkbook-theme-guide" fill="none" stroke="${DOCUMENT_THEME_FALLBACK.guide}" stroke-width="2"`,
      ),
      path("M0 102 L10 102"),
    ]);
    expect(validateSafeSvg(input)).not.toBeNull();
    expect(await prepareStaticExportFragments(input, { workScheduler })).toEqual([
      { minY: -Infinity, maxY: Infinity, background: false },
      { minY: 98, maxY: 106, background: false },
    ]);
  });
});

describe("static SVG arc bounds", () => {
  it.each([
    ["M-10 0 A10 20 0 0 1 10 0", -20, 20],
    ["M-20 5 A10 5 0 0 1 20 5", -5, 15],
    ["M0-10 A10 5 0 1 0 0 10", -10, 10],
    ["M0-5 A10 20 0 0 0 0 5", -20, 20],
    ["M100 100a10 20 0 1 1 20 0", 80, 120],
    ["M100 250 A10 20 0 1 0 100 250", 250, 250],
    ["M100 250a10 20 0 0 1 0 0", 250, 250],
  ])(
    "contains the full corrected ellipse, including degenerate endpoints: %s",
    async (data, min, max) => {
      const result = await prepareStaticExportFragments(svg([path(data, 'stroke="none"')]), {
        workScheduler,
      });
      expect(result).toHaveLength(1);
      expect(Number.isFinite(result![0]!.minY)).toBe(true);
      expect(Number.isFinite(result![0]!.maxY)).toBe(true);
      expect(result![0]!.minY).toBeLessThanOrEqual(min);
      expect(result![0]!.maxY).toBeGreaterThanOrEqual(max);
    },
  );

  it("contains analytic circle extrema for both center signs and every arc flag", async () => {
    const content = ["0 0", "0 1", "1 0", "1 1"].map((flags) =>
      path(`M-6-3 A10 10 0 ${flags} 6 3`, 'stroke="none"'),
    );
    // The two radius-10 circles through (+/-6,+/-3) have center Y = +/-2*sqrt(11).
    const extent = 10 + 2 * Math.sqrt(11);
    const result = await prepareStaticExportFragments(svg(content), { workScheduler });
    expect(result).toHaveLength(4);
    for (const fragment of result!) {
      expect(fragment.minY).toBeLessThanOrEqual(-extent);
      expect(fragment.maxY).toBeGreaterThanOrEqual(extent);
      expect(Number.isFinite(fragment.minY)).toBe(true);
      expect(Number.isFinite(fragment.maxY)).toBe(true);
    }
  });

  it("keeps extreme valid radii finite and applies translations and stroke padding", async () => {
    const input = svg([
      `<g transform="translate(10 300)">${path("M-10 0 A10 20 0 0 1 10 0")}</g>`,
      path("M0 0 A1000000 1000000 0 0 1 0.001 0", 'stroke="none"'),
      path("M-1000000 0 A0.001 0.001 0 1 0 1000000 0", 'stroke="none"'),
    ]);
    expect(validateSafeSvg(input)).not.toBeNull();
    const result = await prepareStaticExportFragments(input, { workScheduler });
    expect(result![0]!.minY).toBeLessThanOrEqual(276);
    expect(result![0]!.maxY).toBeGreaterThanOrEqual(324);
    for (const fragment of result!) {
      expect(Number.isFinite(fragment.minY)).toBe(true);
      expect(Number.isFinite(fragment.maxY)).toBe(true);
    }
    expect(result![1]!.minY).toBeLessThanOrEqual(-2_000_000);
    expect(result![1]!.maxY).toBeGreaterThanOrEqual(2_000_000);
    expect(result![2]!.minY).toBeLessThanOrEqual(-1_000_000);
    expect(result![2]!.maxY).toBeGreaterThanOrEqual(1_000_000);
  });
});

describe("static SVG arc numerical safety and locality", () => {
  it("contains the large-radius relative arc extrema near the coordinate boundary", async () => {
    const input = svg([
      path("M999999.999 1000000 a0.001 500000 0 1 0 -0.001 -200000", 'stroke="none"'),
    ]);
    expect(validateSafeSvg(input)).not.toBeNull();
    const result = await prepareStaticExportFragments(input, { workScheduler });
    expect(result).toHaveLength(1);
    expect(Number.isFinite(result![0]!.minY)).toBe(true);
    expect(Number.isFinite(result![0]!.maxY)).toBe(true);
    // Independently established ellipse extrema protect against subtracting nearly equal Xs.
    expect(result![0]!.minY).toBeLessThanOrEqual(8825.817084882);
    expect(result![0]!.maxY).toBeGreaterThanOrEqual(1_008_825.817084882);
  });

  it("keeps many small arc fragments within separated rows", async () => {
    const rowDistance = 100;
    const content = Array.from({ length: 200 }, (_, index) => {
      const y = index * rowDistance + rowDistance / 2;
      return path(`M0 ${y} A1 1 0 0 1 2 ${y}`);
    });
    const result = await prepareStaticExportFragments(svg(content), { workScheduler });
    expect(result).toHaveLength(content.length);
    for (const [index, fragment] of result!.entries()) {
      expect(fragment.maxY - fragment.minY).toBeLessThan(rowDistance);
      expect(fragment.minY).toBeGreaterThan(index * rowDistance);
      expect(fragment.maxY).toBeLessThan((index + 1) * rowDistance);
    }
  });
});

describe("static SVG export fragment validation and cancellation", () => {
  it.each([
    '<rect width="10" height="10"/>',
    '<g opacity="0.5"></g>',
    `<g opacity="0.5">${path("M0 0 L1 1")}${path("M0 2 L1 3")}</g>`,
    `<g opacity="0.5"><g opacity="1">${path("M0 0 L1 1")}</g></g>`,
    path("M0 0 X10 20"),
    path("M0 0 L1e2 20"),
    '<path fill="#112233FF"/>',
    '<path d="M0 0 L1 1" transform="scale(100)"/>',
    '<path d="M0 0 L1 1" onload="unexpected()"/>',
  ])("falls back without publishing incomplete fragment bounds: %s", async (markup) => {
    expect(await prepareStaticExportFragments(svg([markup]), { workScheduler })).toBeUndefined();
  });

  it("rejects incomplete prefixes, bands, group closures and trailing markup", async () => {
    const input = svg([path("M0 0 L1 1")]);
    const invalid = [
      input.replace("</metadata>", ""),
      input.replace('id="inkbook-content"', 'id="unexpected"'),
      input.replace("</svg>", ""),
      `${input}<path/>`,
    ];
    for (const value of invalid) {
      expect(await prepareStaticExportFragments(value, { workScheduler })).toBeUndefined();
    }
  });

  it("stops cancelled preparation and permits a fresh independent preparation", async () => {
    const controller = new AbortController();
    const scheduler = createTestWorkScheduler({
      checkpoint: () => {
        controller.abort();
        return undefined;
      },
    });
    await expect(
      prepareStaticExportFragments(svg([path("M0 0 L1 1")]), {
        workScheduler: scheduler,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(await prepareStaticExportFragments(svg([]), { workScheduler })).toEqual([]);
  });
});
