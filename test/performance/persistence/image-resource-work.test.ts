import { afterEach, expect, it, vi } from "vitest";
import { rasterImage, rasterResource } from "../../fixtures/persistence/image-svg";
import { TestWorkScheduler } from "../../fixtures/persistence/work-scheduler";
import {
  createImageResource,
  validateImageResource,
} from "../../../src/persistence/images/image-resources";
import { SampleBase64Reader } from "../../../src/persistence/serialization/metadata/sample-base64";
import { IncrementalDocumentSerializer } from "../../../src/persistence/serialization/output/incremental-document-serializer";
import { createSnapshot } from "../../unit/persistence/serialization/fixtures";
import { ChunkedInkbookInputParser } from "../../../src/persistence/serialization/input/chunked-input-codec";
import {
  extendedWebpHeader,
  webpBytes,
  webpChunk,
  webpContainer,
} from "../../fixtures/persistence/webp-images";
import { ChunkedSha256 } from "../../../src/persistence/serialization/chunked-output-sha256";
import * as autoExport from "../../../src/persistence/serialization/output/auto-contrast-export";
import { createTestStroke } from "../../fixtures/persistence/worker-snapshot";

afterEach(() => vi.restoreAllMocks());

it("shares bounded underlay source trees across ten thousand small Auto strokes", async () => {
  const resource = rasterResource();
  const original = createTestStroke();
  const strokes = Array.from({ length: 10_000 }, (_, index) => {
    const x = 100 + (index % 100) * 12;
    const y = 12 + Math.floor(index / 100) * 9;
    return {
      ...original,
      id: `00000000-0000-4000-8000-${String(index + 1000).padStart(12, "0")}`,
      points: [x, y, 0.5, x + 8, y + 3, 0.5],
      style: { ...original.style, pressureEnabled: false },
    };
  });
  const serializer = new IncrementalDocumentSerializer();
  expect(
    serializer.reset({
      ...createSnapshot([rasterImage(resource), ...strokes]),
      version: 5,
      imageResources: [resource],
    }).ok,
  ).toBe(true);
  const result = await serializer.serializeRuntimeChunked({});
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  const svg = new TextDecoder().decode(result.value.svg);
  // These are the emitted browser source-instance boundaries, not test-loop counters.
  expect(svg.match(/<use href="#inkbook-auto-underlay"/gu)).toHaveLength(1102);
  expect(svg.match(/<pattern id="inkbook-auto-paint-/gu)).toHaveLength(10_000);
  expect(svg.match(/<filter /gu)).toHaveLength(1102);
  const aliases = [...svg.matchAll(/<pattern id="inkbook-auto-paint-[^>]+/gu)];
  expect(aliases.every(([markup]) => markup.includes('width="10" height="5"'))).toBe(true);
  expect(serializer.instrumentation.cacheBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  serializer.clear();
  expect(serializer.instrumentation.cacheBytes).toBe(0);
});

it("reuses Auto wrapper plans and buffers across image-only and page-only updates", async () => {
  const resource = rasterResource();
  const image = rasterImage(resource);
  const strokes = Array.from({ length: 128 }, (_, index) => ({
    ...createTestStroke(),
    id: `00000000-0000-4000-8000-${String(index + 1000).padStart(12, "0")}`,
  }));
  const serializer = new IncrementalDocumentSerializer();
  expect(
    serializer.reset({
      ...createSnapshot([image, ...strokes]),
      version: 5,
      imageResources: [resource],
    }).ok,
  ).toBe(true);
  expect((await serializer.serializeRuntimeChunked({})).ok).toBe(true);
  const warmed = serializer.instrumentation;
  const prepare = vi.spyOn(autoExport, "prepareAutoPresentationSteps");
  const encode = vi.spyOn(TextEncoder.prototype, "encode");
  for (const [index, delta] of [
    { changedElements: [{ ...image, x: 120, contrast: "light" as const }] },
    {
      page: {
        ...serializer.currentPage()!,
        background: { type: "lines" as const, spacing: 25 as const },
      },
    },
  ].entries()) {
    prepare.mockClear();
    encode.mockClear();
    expect(
      serializer.applyDelta({ ...delta, baseModelRevision: 7 + index, modelRevision: 8 + index })
        .ok,
    ).toBe(true);
    const result = await serializer.serializeRuntimeChunked({});
    expect(result.ok).toBe(true);
    expect(
      prepare.mock.calls.filter(([fragment]) => fragment.element.kind !== "image"),
    ).toHaveLength(0);
    expect(encode.mock.calls.filter(([text]) => text?.includes("inkbook-auto-atom-"))).toHaveLength(
      0,
    );
    expect(serializer.instrumentation.shapeBuilds).toBe(warmed.shapeBuilds);
    expect(serializer.instrumentation.cacheBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    if (result.ok) expect(result.value.snapshot.revision).toBe(8 + index);
  }
  serializer.clear();
  expect(serializer.instrumentation.cacheBytes).toBe(0);
});

it("bounds real WebP chunk visits between shared scheduler checkpoints and aborts before encoding", async () => {
  const chunks = Array.from({ length: 4096 }, () => webpChunk("TEST"));
  const bytes = webpContainer(extendedWebpHeader(3, 2), webpBytes().slice(12), ...chunks);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Forward the observed DataView receiver through call().
  const read = DataView.prototype.getUint32;
  let visits = 0;
  vi.spyOn(DataView.prototype, "getUint32").mockImplementation(function (
    this: DataView,
    offset: number,
    littleEndian?: boolean,
  ) {
    if (
      this.buffer === bytes.buffer &&
      this.byteLength === bytes.byteLength &&
      offset >= 12 &&
      littleEndian !== true
    )
      visits += 1;
    return read.call(this, offset, littleEndian);
  });
  let previousVisits = 0;
  const scheduler = new TestWorkScheduler({
    checkpoint: () => {
      expect(visits - previousVisits).toBeLessThanOrEqual(512);
      previousVisits = visits;
      return undefined;
    },
  });
  await expect(createImageResource(bytes, "image/webp", scheduler)).resolves.toMatchObject({
    width: 3,
    height: 2,
  });
  expect(visits).toBe(chunks.length + 2);
  visits = 0;
  const hashes = vi.spyOn(ChunkedSha256.prototype, "update");
  const controller = new AbortController();
  const abortingScheduler = new TestWorkScheduler({
    checkpoint: () => {
      controller.abort();
      return undefined;
    },
  });
  await expect(
    createImageResource(bytes, "image/webp", abortingScheduler, controller.signal),
  ).rejects.toThrow();
  expect(visits).toBeGreaterThan(0);
  expect(visits).toBeLessThanOrEqual(512);
  expect(hashes).not.toHaveBeenCalled();
});

it("retains one verified raster payload through moves and aborts untrusted decoding at scheduler checkpoints", async () => {
  const source = rasterResource();
  const bytes = new Uint8Array(1024 * 1024);
  bytes.set(Uint8Array.from(atob(source.data), (value) => value.charCodeAt(0)));
  const resource = await createImageResource(bytes, "image/png", new TestWorkScheduler());
  const image = rasterImage(resource);
  const reads = vi.spyOn(SampleBase64Reader.prototype, "read");
  const serializer = new IncrementalDocumentSerializer();
  expect(
    serializer.reset({ ...createSnapshot([image]), version: 3, imageResources: [resource] }).ok,
  ).toBe(true);
  expect(
    serializer.applyDelta({
      baseModelRevision: 7,
      modelRevision: 8,
      changedElements: [{ ...image, x: image.x + 10 }],
    }).ok,
  ).toBe(true);
  expect(serializer.currentImageResources()).toEqual([resource]);
  expect(reads).not.toHaveBeenCalled();
  const exported = await serializer.serializeRuntimeChunked({});
  expect(exported.ok).toBe(true);
  if (!exported.ok) throw new Error(exported.error.message);
  const parser = new ChunkedInkbookInputParser({ staticValidation: "safe" });
  expect((await parser.write(exported.value.svg)).ok).toBe(true);
  expect((await parser.finish()).ok).toBe(true);
  expect(reads).toHaveBeenCalledTimes(bytes.length);
  reads.mockClear();
  const controller = new AbortController();
  const scheduler = new TestWorkScheduler({
    checkpoint: () => {
      controller.abort();
      return undefined;
    },
  });
  await expect(
    validateImageResource({ ...resource }, scheduler, controller.signal),
  ).rejects.toThrow();
  expect(reads).toHaveBeenCalledTimes(4096);
  serializer.clear();
  expect(serializer.currentImageResources()).toEqual([]);
});
