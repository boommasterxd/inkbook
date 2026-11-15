import { describe, expect, it } from "vitest";
import {
  validateEditableSafeSvgPreludeSteps,
  validateSafeSvg,
} from "../../../../src/persistence/documents/safe-svg-validator";
import { rasterResource, rasterSvg } from "../../../fixtures/persistence/image-svg";
import { exhaustValidation } from "../../../fixtures/persistence/safe-svg";
import { StreamingSafeStaticValidator } from "../../../../src/persistence/serialization/input/streaming-safe-static";
import { parseSafeImageDefinitionsSteps } from "../../../../src/persistence/documents/safe-svg-images";
import {
  imageDefinitionsMarkup,
  serializeImageMarkup,
} from "../../../../src/persistence/serialization/output/image-markup";
import { inspectPreviewSvg } from "../../../../src/obsidian/embeds/preview/safe-preview-svg";
import { serializeSvgEnvelope } from "../../../../src/persistence/documents/svg-envelope";
import { imageElement } from "../../../fixtures/domain/images";
import { capacityImageResource } from "../../../fixtures/persistence/images";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { createWorkerSnapshot } from "../../../fixtures/persistence/worker-snapshot";
import { webpBytes } from "../../../fixtures/persistence/webp-images";
import { createImageResource } from "../../../../src/persistence/images/image-resources";

it.each(["lossless", "lossy", "alpha"] as const)(
  "retains a verified %s WebP data URL through safe SVG and locked preview inspection",
  async (kind) => {
    const scheduler = new TestWorkScheduler();
    const asset = await createImageResource(webpBytes(kind), "image/webp", scheduler);
    const element = {
      ...imageElement(),
      assetId: asset.id,
      crop: { x: 0, y: 0, width: 3, height: 2 },
    };
    const svg = serializeSvgEnvelope(
      { ...createWorkerSnapshot([element]), version: 3, imageResources: [asset] },
      1000,
      { background: [], images: [serializeImageMarkup(element)], highlights: [], content: [] },
    );
    expect(validateSafeSvg(svg)?.imageResources).toEqual([asset]);
    expect(await inspectPreviewSvg(svg, { workScheduler: scheduler })).not.toBeNull();
    expect(validateSafeSvg(svg.replace("data:image/webp;", "data:image/png;"))).toBeNull();
  },
);

describe("strict raster SVG envelope", () => {
  it("bounds aggregate decoded pixels in complete preview inspection and prevalidated definitions", async () => {
    const assets = await Promise.all(
      Array.from({ length: 9 }, (_, index) => capacityImageResource(index)),
    );
    const elements = assets.map((asset, index) => ({
      ...imageElement(),
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      assetId: asset.id,
      crop: { x: 0, y: 0, width: asset.width, height: asset.height },
    }));
    for (const count of [8, 9]) {
      const resources = assets.slice(0, count);
      const definitions = imageDefinitionsMarkup(resources);
      for (const validateResource of [true, false]) {
        const parsed = exhaustValidation(
          parseSafeImageDefinitionsSteps(definitions, 0, validateResource),
        ).result;
        expect(parsed?.resources.length ?? null).toBe(count === 8 ? 8 : null);
      }
      const images = elements.slice(0, count);
      const svg = serializeSvgEnvelope(
        { ...createWorkerSnapshot(images), version: 3, imageResources: resources },
        1000,
        {
          background: [],
          images: images.map(serializeImageMarkup),
          highlights: [],
          content: [],
        },
      );
      const preview = await inspectPreviewSvg(svg, { workScheduler: new TestWorkScheduler() });
      expect(preview === null).toBe(count === 9);
    }
  });

  it.each([1, 17, 4096])(
    "validates raster instances across %s-character input chunks",
    async (size) => {
      const svg = rasterSvg();
      const suffix = svg.slice(svg.indexOf("</metadata>") + 11);
      const validator = new StreamingSafeStaticValidator(() => undefined, 3, [rasterResource()]);
      for (let cursor = 0; cursor < suffix.length; cursor += size)
        expect(await validator.write(suffix.slice(cursor, cursor + size))).toBe(true);
      expect(validator.finish()).toBe(true);
      expect(validator.maximumRetainedCharacters).toBeLessThan(4096);
    },
  );

  it("fails closed on unbound streamed instances and bounds incomplete image syntax", async () => {
    const prefix = '<g id="inkbook-background"></g><g id="inkbook-images-band">';
    const missing = new StreamingSafeStaticValidator(() => undefined, 3);
    const svg = rasterSvg();
    expect(await missing.write(svg.slice(svg.indexOf("</metadata>") + 11))).toBe(false);
    const oversized = new StreamingSafeStaticValidator(() => undefined, 3, [rasterResource()]);
    expect(await oversized.write(prefix + '<g transform="' + " ".repeat(4096))).toBe(false);
    expect(oversized.finish()).toBe(false);
  });

  it("admits one verified payload and its known local crop reference", () => {
    const svg = rasterSvg(90);
    const safe = validateSafeSvg(svg);
    expect(safe?.version).toBe(3);
    expect(safe?.imageResources).toEqual([rasterResource()]);
    expect(safe?.groups.images).toBeDefined();
    const prefix = svg.slice(0, svg.indexOf(">", svg.indexOf("<metadata")) + 1);
    expect(
      exhaustValidation(validateEditableSafeSvgPreludeSteps(prefix)).result?.imageResources,
    ).toEqual([rasterResource()]);
  });

  it.each([
    (svg: string) => svg.replace("data:image/png;base64,", "data:image/svg+xml;base64,"),
    (svg: string) => svg.replace("data:image/png;base64,", "data:image/jpeg;base64,"),
    (svg: string) =>
      svg.replace(rasterResource().data, rasterResource().data.replace("YII=", "YIJ=")),
    (svg: string) => svg.replace("data:image/png;base64,", "https://invalid/"),
    (svg: string) => svg.replace('href="#inkbook-image-', 'href="https://invalid/#inkbook-image-'),
    (svg: string) => svg.replace('href="#inkbook-image-', 'href="#missing-'),
    (svg: string) => svg.replace('viewBox="0 0 1 1"', 'viewBox="0 0 2 1"'),
    (svg: string) => svg.replace('overflow="hidden"', 'overflow="visible"'),
    (svg: string) => svg.replace("<use href=", '<use onclick="bad()" href='),
    (svg: string) => svg.replace('width="1" height="1" href=', 'width="2" height="1" href='),
    (svg: string) => svg.replace(rasterResource().id, "a".repeat(64)),
    (svg: string) => svg.replace(rasterResource().data, "AAAA"),
    (svg: string) => svg.replace('data-inkbook-version="3"', 'data-inkbook-version="2"'),
    (svg: string) => svg.replace("</defs>", `<use href="#inkbook-images"/></defs>`),
    (svg: string) =>
      svg.replace("</defs>", `${svg.slice(svg.indexOf("<image "), svg.indexOf("</defs>"))}</defs>`),
  ])("rejects unsafe payloads, references, crops and attributes", (mutate) => {
    expect(validateSafeSvg(mutate(rasterSvg()))).toBeNull();
  });
});
