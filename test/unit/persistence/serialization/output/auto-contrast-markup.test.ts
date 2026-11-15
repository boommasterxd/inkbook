import { expect, it, vi } from "vitest";
import { calculateElementBounds } from "../../../../../src/domain/geometry/public";
import {
  autoExportFragment,
  autoExportFragmentSteps,
} from "../../../../../src/persistence/serialization/output/auto-contrast-export";
import { buildElementFragments } from "../../../../../src/persistence/serialization/output/element-fragments";
import { autoPaintTiles } from "../../../../../src/persistence/serialization/output/auto-contrast-tiles";
import { serializeAutoElementPaths } from "../../../../../src/persistence/serialization/output/path-markup";
import { createTestStroke } from "../../../../fixtures/persistence/worker-snapshot";
import { textElement } from "../../../domain/schema/fixtures";
import { createAllElementSnapshot, createSnapshot } from "../fixtures";
import { rasterImage, rasterResource } from "../../../../fixtures/persistence/image-svg";
import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/document-codec";
import { IncrementalDocumentSerializer } from "../../../../../src/persistence/serialization/output/incremental-document-serializer";
import { parseInkbookDocumentForTest } from "../../../../fixtures/persistence/parse-document";
import { EncodedByteBudget } from "../../../../../src/persistence/serialization/output/encoded-byte-budget";
import { loadBuiltinFont } from "../../../../../src/persistence/fonts/builtin-fonts";
import { TestWorkScheduler } from "../../../../fixtures/persistence/work-scheduler";
import { matchesCanonicalFontOutput } from "../../../../../src/persistence/serialization/output/font-output-binding";

it("shares cached contour bytes and opacity across bounded tiles without rereading samples", () => {
  let reads = 0;
  const original = createTestStroke();
  const points = new Proxy([10, 10, 0.5, 20, 5000, 1], {
    get: (target, key, receiver) => {
      if (typeof key === "string" && /^\d+$/u.test(key)) reads += 1;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  const stroke = {
    ...original,
    points,
    offset: { x: 15, y: 20 },
    style: { ...original.style, opacity: 0.4 },
  };
  const bounds = calculateElementBounds(stroke);
  const cached = buildElementFragments(stroke, bounds.maxY, undefined, undefined, bounds);
  reads = 0;
  const prepared = autoExportFragment(cached);
  expect(reads).toBe(0);
  expect(
    prepared.presentation?.chunks.some((chunk) => chunk.buffer === cached.svgUtf8.buffer),
  ).toBe(true);
  expect(prepared.svg.match(/<path /gu)).toHaveLength(1);
  expect(prepared.svg.match(/<svg /gu)).toHaveLength(3);
  expect(prepared.svg.match(/opacity="0.4"/gu)).toHaveLength(1);
  expect(prepared.svg).toContain('patternTransform="translate(-15 -20)"');
  expect(prepared.svg).toBe([...serializeAutoElementPaths(stroke, bounds)].join(""));
  expect(prepared.bytes).toBe(
    prepared.metadataBytes + new TextEncoder().encode(prepared.svg).length,
  );
});

it("adapts only the selected shape paint channels while preserving fixed colors", () => {
  const rectangle = createAllElementSnapshot().elements.find(
    (element) => element.kind === "rectangle",
  )!;
  const markup = [...serializeAutoElementPaths(rectangle)].join("");
  expect(markup).toContain('stroke="inherit"');
  expect(markup).toContain('fill="#33669980"');
  expect(markup).not.toContain('fill="inherit"');
  expect(markup).toMatch(
    /<use href="#inkbook-auto-geometry-[^"]+" fill="none" stroke="url\(#[^)]+\)"\/>/u,
  );
  const adaptiveFill = {
    ...rectangle,
    style: {
      ...rectangle.style,
      fillColor: { type: "theme-text" as const },
      outlineColor: { type: "rgba" as const, value: "#33669980" as const },
    },
  };
  const fillMarkup = [...serializeAutoElementPaths(adaptiveFill)].join("");
  expect(fillMarkup).toContain('fill="inherit"');
  expect(fillMarkup).toContain('stroke="#33669980"');
  expect(fillMarkup).toMatch(
    /<use href="#inkbook-auto-geometry-[^"]+" fill="url\(#[^)]+\)" stroke="none"\/>/u,
  );
  const adaptiveBoth = {
    ...adaptiveFill,
    style: { ...adaptiveFill.style, outlineColor: { type: "theme-text" as const } },
  };
  expect([...serializeAutoElementPaths(adaptiveBoth)].join("")).toMatch(
    /<use href="#inkbook-auto-geometry-[^"]+" fill="(url\(#[^)]+\))" stroke="\1"\/>/u,
  );
});

it("keeps rotated text and locally translated math fill-only", () => {
  const text = textElement();
  text.layout.lines[0]!.runs[0]!.inkBounds = { minX: 0, minY: -15, maxX: 40, maxY: 5 };
  text.rotation = 35;
  text.layout.math = [
    {
      start: 0,
      end: 1,
      display: false,
      x: 3,
      y: 4,
      width: 10,
      height: 10,
      paths: [{ d: "M0 0L10 0L0 10Z" }],
    },
  ];
  const markup = [...serializeAutoElementPaths(text)].join("");
  expect(markup).toContain(`rotate(-35 ${text.pivot.x} ${text.pivot.y})`);
  expect(markup).toContain(
    `translate(${-text.x - 3} ${-text.y - 4}) rotate(-35 ${text.pivot.x} ${text.pivot.y})`,
  );
  expect(markup).toContain('fill="inherit"');
  const geometryUses = [...markup.matchAll(/<use href="#inkbook-auto-geometry-[^>]+\/>/gu)];
  expect(geometryUses).toHaveLength(2);
  for (const [use] of geometryUses) {
    expect(use).toContain('fill="url(#inkbook-auto-paint-');
    expect(use).toContain('stroke="none"');
  }
});

it("uses each prepared run's small paint region in a thousand-line text field", () => {
  const text = textElement();
  text.source = "x\n".repeat(1000);
  text.height = 40_000;
  text.layout.lines = Array.from({ length: 1000 }, (_, index) => ({
    x: 0,
    y: index * 40,
    width: 8,
    height: 20,
    baseline: 15,
    runs: [
      {
        text: "x",
        start: index * 2,
        end: index * 2 + 1,
        x: 0,
        width: 8,
        inkBounds: { minX: 0, minY: -15, maxX: 8, maxY: 5 },
      },
    ],
  }));
  const markup = [...serializeAutoElementPaths(text)].join("");
  const filters = [...markup.matchAll(/<pattern [^>]*width="([^"]+)" height="([^"]+)"/gu)];
  expect(filters).toHaveLength(1000);
  for (const filter of filters) {
    expect(Number(filter[1])).toBeLessThan(20);
    expect(Number(filter[2])).toBeLessThan(32);
  }
});

it("retains measured glyph overhang and avoids an adaptive raster for genuinely empty ink", () => {
  const text = textElement();
  const line = text.layout.lines[0]!;
  const run = line.runs[0]!;
  run.text = "‾";
  run.width = 26.64;
  run.inkBounds = { minX: 0, minY: -60, maxX: 53, maxY: 0 };
  const markup = [...serializeAutoElementPaths(text)].join("");
  expect(markup).toContain('width="53" height="60"');
  run.text = " ";
  run.inkBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const empty = [...serializeAutoElementPaths(text)].join("");
  expect(empty).not.toContain("<pattern ");
  text.style.underline = true;
  expect([...serializeAutoElementPaths(text)].join("")).toContain("<pattern ");
});

it("keeps measured version-five text without images on the ordinary theme paint path", async () => {
  const font = await loadBuiltinFont("inter", 400, "normal", new TestWorkScheduler());
  const text = textElement();
  text.style.fontFamily = "inter";
  text.layout.lines[0]!.runs[0]!.inkBounds = { minX: 0, minY: -15, maxX: 40, maxY: 5 };
  const snapshot = { ...createSnapshot([text]), version: 5 as const, fontResources: [font] };
  const full = serializeInkbookDocument(snapshot);
  expect(full.ok, JSON.stringify(full)).toBe(true);
  if (!full.ok) return;
  expect(full.value.snapshot.version).toBe(5);
  expect(full.value.svg).not.toContain('id="inkbook-auto"');
  expect(full.value.svg).not.toContain('id="inkbook-auto-atom-');
  expect(full.value.svg).toContain('class="inkbook-theme-fill"');
  expect(await matchesCanonicalFontOutput(full.value.svg, [font], () => undefined)).toBe(true);
  const serializer = new IncrementalDocumentSerializer();
  expect(serializer.reset(snapshot).ok).toBe(true);
  const incremental = await serializer.serializeChunked();
  expect(incremental.ok, JSON.stringify(incremental)).toBe(true);
  if (incremental.ok) expect(incremental.value.svg).toBe(full.value.svg);
  expect((await parseInkbookDocumentForTest(full.value.svg)).ok).toBe(true);
});

it("requires native preparation for legacy Auto text instead of silently clipping it", async () => {
  const font = await loadBuiltinFont("inter", 400, "normal", new TestWorkScheduler());
  const text = textElement();
  text.style.fontFamily = "inter";
  const resource = rasterResource();
  const image = rasterImage(resource);
  const snapshot = {
    ...createSnapshot([image, text]),
    version: 5 as const,
    imageResources: [resource],
    fontResources: [font],
  };
  expect(serializeInkbookDocument(snapshot)).toMatchObject({
    ok: false,
    error: {
      code: "snapshot-invalid",
      message: "Automatic text contrast requires prepared glyph ink bounds.",
    },
  });
  const serializer = new IncrementalDocumentSerializer();
  expect(serializer.reset(snapshot).ok).toBe(true);
  expect(serializer.serialize()).toMatchObject({ ok: false, error: { code: "snapshot-invalid" } });
  expect(await serializer.serializeChunked()).toMatchObject({
    ok: false,
    error: { code: "snapshot-invalid" },
  });
});

it("cancels derived presentation before publishing partial tile resources", () => {
  const stroke = createTestStroke();
  const cached = buildElementFragments(stroke);
  const controller = new AbortController();
  const steps = autoExportFragmentSteps(cached, controller.signal);
  expect(steps.next().done).toBe(false);
  controller.abort();
  expect(() => steps.next()).toThrow();
  expect(cached.presentation).toBeUndefined();
});

it("bounds complete-page tiling without allocating an array of off-page cells", () => {
  const tiles = [
    ...autoPaintTiles({ minX: -1_000_000, minY: -1_000_000, maxX: 1_000_000, maxY: 1_000_000 }),
  ];
  expect(tiles).toHaveLength(978);
  expect(tiles.every((tile) => tile.width <= 2048 && tile.height <= 2048)).toBe(true);
  expect(tiles[0]).toEqual({ x: 0, y: 0, width: 2048, height: 2048 });
});

it("round-trips auto ink with one raster payload and reuses contour fragments after an underlay edit", async () => {
  const resource = rasterResource();
  const image = rasterImage(resource);
  const stroke = createTestStroke();
  stroke.points = [50, 220, 0.5, 350, 220, 1];
  stroke.style.opacity = 0.4;
  const snapshot = {
    ...createSnapshot([image, stroke]),
    version: 5 as const,
    imageResources: [resource],
  };
  const expected = serializeInkbookDocument(snapshot);
  expect(expected.ok, JSON.stringify(expected)).toBe(true);
  if (!expected.ok) return;
  expect(expected.value.svg.split(resource.data)).toHaveLength(2);
  const serializer = new IncrementalDocumentSerializer();
  expect(serializer.reset(snapshot).ok).toBe(true);
  const actual = await serializer.serializeChunked();
  expect(actual.ok, JSON.stringify(actual)).toBe(true);
  if (!actual.ok) return;
  expect(actual.value.svg).toEqual(expected.value.svg);
  const parsed = await parseInkbookDocumentForTest(actual.value.svg);
  expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
  if (parsed.ok) expect(parsed.value.snapshot.elements).toHaveLength(2);
  const shapes = serializer.instrumentation.shapeBuilds;
  const content = actual.value.svg.slice(actual.value.svg.indexOf('<g id="inkbook-content">'));
  expect(
    serializer.applyDelta({
      baseModelRevision: 7,
      modelRevision: 8,
      changedElements: [{ ...image, x: 120, contrast: "light" }],
    }).ok,
  ).toBe(true);
  const changed = serializer.serialize();
  expect(changed.ok, JSON.stringify(changed)).toBe(true);
  if (changed.ok) {
    expect(changed.value.svg.slice(changed.value.svg.indexOf('<g id="inkbook-content">'))).toBe(
      content,
    );
    const restored = await parseInkbookDocumentForTest(changed.value.svg);
    expect(restored.ok, JSON.stringify(restored)).toBe(true);
    if (restored.ok)
      expect(restored.value.snapshot.elements[0]).toMatchObject({ contrast: "light", x: 120 });
  }
  expect(serializer.instrumentation.shapeBuilds).toBe(shapes);
});

it("returns a structured public export failure when derived markup reaches its byte capacity", () => {
  const resource = rasterResource();
  const image = rasterImage(resource);
  const reserve = vi.spyOn(EncodedByteBudget.prototype, "tryReserve").mockReturnValue(false);
  try {
    expect(
      serializeInkbookDocument({
        ...createSnapshot([image, createTestStroke()]),
        version: 5,
        imageResources: [resource],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "static-output-limit-exceeded" },
    });
    expect(reserve).toHaveBeenCalledOnce();
  } finally {
    reserve.mockRestore();
  }
});
