import { afterEach, expect, it, vi } from "vitest";
import { rasterImage, rasterResource } from "../../fixtures/persistence/image-svg";
import { TestWorkScheduler } from "../../fixtures/persistence/work-scheduler";
import {
  createImageResource,
  validateImageResourceSteps,
} from "../../../src/persistence/images/image-resources";
import {
  SampleBase64Reader,
  SampleBase64Writer,
} from "../../../src/persistence/serialization/metadata/sample-base64";
import { IMAGE_LIMITS } from "../../../src/domain/images/image-limits";
import { sha256Hex } from "../../../src/persistence/serialization/sha256";
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
import {
  createTestStroke,
  createCapacityStrokes,
} from "../../fixtures/persistence/worker-snapshot";
import { SvgInputPrelude } from "../../../src/persistence/serialization/input/svg-input-prelude";

afterEach(() => vi.restoreAllMocks());

it("encodes a capacity raster through bounded native chunks and one private native digest", async () => {
  const source = rasterResource();
  const bytes = new Uint8Array(IMAGE_LIMITS.resourceBytes);
  bytes.set(Uint8Array.from(atob(source.data), (character) => character.charCodeAt(0)));
  const expected = {
    id: sha256Hex(bytes),
    data: (bytes as Uint8Array & { toBase64: () => string }).toBase64(),
  };
  const base64 = vi.spyOn(
    Uint8Array.prototype as Uint8Array & { toBase64: () => string },
    "toBase64",
  );
  const append = vi.spyOn(SampleBase64Writer.prototype, "append");
  const hash = vi.spyOn(ChunkedSha256.prototype, "update");
  const digest = vi.spyOn(crypto.subtle, "digest");
  const result = await createImageResource(bytes, "image/png", new TestWorkScheduler());
  expect(result).toMatchObject(expected);
  expect(append).not.toHaveBeenCalled();
  expect(hash).not.toHaveBeenCalled();
  expect(base64).toHaveBeenCalledTimes(Math.ceil(bytes.length / (48 * 1024)));
  expect(base64.mock.contexts.every((chunk) => (chunk as Uint8Array).byteLength <= 48 * 1024)).toBe(
    true,
  );
  expect(
    base64.mock.contexts.reduce<number>((sum, chunk) => sum + (chunk as Uint8Array).byteLength, 0),
  ).toBe(bytes.length);
  expect(digest).toHaveBeenCalledExactlyOnceWith("SHA-256", expect.any(Uint8Array));
  expect(digest.mock.calls[0]![1].byteLength).toBe(bytes.length);
  expect(digest.mock.calls[0]![1]).not.toBe(bytes);
});

it("retains one raster payload beside ten thousand theme and fixed-color strokes without regional paint", async () => {
  const resource = rasterResource();
  const strokes = createCapacityStrokes();
  for (let index = 0; index < strokes.length; index += 2)
    strokes[index]!.style.color = { type: "theme-text" };
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
  // Observe actual emitted asset and path boundaries across the full capacity fixture.
  expect(svg.match(/<image /gu)).toHaveLength(1);
  expect(svg.match(/<use href="#inkbook-image-/gu)).toHaveLength(1);
  // The fixture has one page path and one guide path in addition to the ink.
  expect(svg.match(/<path /gu)).toHaveLength(strokes.length + 2);
  expect(svg.match(/class="inkbook-theme-stroke"/gu)).toHaveLength(strokes.length / 2);
  expect(svg).not.toMatch(/<(?:filter|mask|pattern)\b/u);
  expect(serializer.instrumentation.cacheBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  serializer.clear();
  expect(serializer.instrumentation.cacheBytes).toBe(0);
});

it("reuses unchanged stroke geometry and encoded fragments across image-only and page-only updates", async () => {
  const resource = rasterResource();
  const image = rasterImage(resource);
  const strokes = Array.from({ length: 128 }, (_, index) => {
    const stroke = createTestStroke();
    return {
      ...stroke,
      id: `00000000-0000-4000-8000-${String(index + 1000).padStart(12, "0")}`,
      style: { ...stroke.style, color: { type: "theme-text" as const } },
    };
  });
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
  for (const [index, delta] of [
    { changedElements: [{ ...image, x: 120 }] },
    {
      page: {
        ...serializer.currentPage()!,
        background: { type: "lines" as const, spacing: 25 as const },
      },
    },
  ].entries()) {
    expect(
      serializer.applyDelta({ ...delta, baseModelRevision: 7 + index, modelRevision: 8 + index })
        .ok,
    ).toBe(true);
    const result = await serializer.serializeRuntimeChunked({});
    expect(result.ok).toBe(true);
    expect(serializer.instrumentation.fragmentBuilds).toBe(warmed.fragmentBuilds + 1);
    expect(serializer.instrumentation.shapeBuilds).toBe(warmed.shapeBuilds);
    expect(serializer.instrumentation.cacheBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    if (result.ok) expect(result.value.snapshot.revision).toBe(8 + index);
  }
  serializer.clear();
  expect(serializer.instrumentation.cacheBytes).toBe(0);
});

it("validates only new image bytes when the worker receives an appended registry", async () => {
  const addition = rasterResource();
  const bytes = new Uint8Array(IMAGE_LIMITS.resourceBytes);
  bytes.set(Uint8Array.from(atob(addition.data), (character) => character.charCodeAt(0)));
  const retained = await createImageResource(bytes, "image/png", new TestWorkScheduler());
  const image = rasterImage(retained);
  const addedImage = rasterImage(addition, { id: "00000000-0000-4000-8000-000000099999" });
  const serializer = new IncrementalDocumentSerializer();
  expect(
    serializer.reset({
      ...createSnapshot([image, ...createCapacityStrokes()]),
      version: 5,
      imageResources: [{ ...retained }],
    }).ok,
  ).toBe(true);
  const known = serializer.currentImageResources()[0];
  const hashes = vi.spyOn(ChunkedSha256.prototype, "update");
  const context = { checkpoint: () => undefined, signal: new AbortController().signal };
  const committed = await serializer.applyDeltaSliced(
    {
      baseModelRevision: 7,
      modelRevision: 8,
      changedElements: [addedImage],
      imageResources: [{ ...retained }, addition],
      orderChanges: { image: [image.id, addedImage.id] },
    },
    context,
  );
  expect(committed.ok).toBe(true);
  expect(serializer.currentImageResources()[0]).toBe(known);
  expect(hashes).toHaveBeenCalledOnce();
  expect(hashes.mock.calls[0]![0].byteLength).toBe(atob(addition.data).length);

  // Keep the claimed digest and metadata while changing only the final decoded byte.
  const changed = { ...retained, data: retained.data.slice(0, -4) + "AAE=" };
  for (const imageResources of [[changed, addition], [addition]]) {
    const invalid = await serializer.applyDeltaSliced(
      {
        baseModelRevision: 8,
        modelRevision: 9,
        imageResources,
      },
      context,
    );
    expect(invalid.ok).toBe(false);
    expect(serializer.currentRevision()).toBe(8);
    expect(serializer.currentImageResources()[0]).toBe(known);
  }
  serializer.clear();
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

it("retains one verified raster payload through moves and aborts untrusted decoding before its next chunk", async () => {
  const source = rasterResource();
  const bytes = new Uint8Array(1024 * 1024);
  bytes.set(Uint8Array.from(atob(source.data), (value) => value.charCodeAt(0)));
  const resource = await createImageResource(bytes, "image/png", new TestWorkScheduler());
  const image = rasterImage(resource);
  const reads = vi.spyOn(SampleBase64Reader.prototype, "read");
  const native = vi.spyOn(
    Uint8Array.prototype as unknown as {
      setFromBase64(input: string, options: unknown): { read: number; written: number };
    },
    "setFromBase64",
  );
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
  expect(reads).not.toHaveBeenCalled();
  expect(native).toHaveBeenCalledTimes(Math.ceil(resource.data.length / (64 * 1024)));
  expect(native.mock.calls.every(([input]) => input.length <= 64 * 1024)).toBe(true);
  native.mockClear();
  const controller = new AbortController();
  const steps = validateImageResourceSteps({ ...resource }, controller.signal);
  expect(steps.next()).toEqual({ done: false, value: undefined });
  expect(native).toHaveBeenCalledOnce();
  controller.abort();
  expect(() => steps.next()).toThrow();
  expect(reads).not.toHaveBeenCalled();
  expect(native).toHaveBeenCalledOnce();
  serializer.clear();
  expect(serializer.currentImageResources()).toEqual([]);
});

it("searches incoming raster prefix chunks once instead of rescanning retained Base64", async () => {
  const bytes = new Uint8Array(2 * 1024 * 1024);
  bytes.set(Uint8Array.from(atob(rasterResource().data), (value) => value.charCodeAt(0)));
  const resource = await createImageResource(bytes, "image/png", new TestWorkScheduler());
  const serializer = new IncrementalDocumentSerializer();
  expect(
    serializer.reset({
      ...createSnapshot([rasterImage(resource)]),
      version: 5,
      imageResources: [resource],
    }).ok,
  ).toBe(true);
  const exported = await serializer.serializeRuntimeChunked({});
  if (!exported.ok) throw new Error(exported.error.message);
  const svg = new TextDecoder().decode(exported.value.svg);
  const metadata = svg.indexOf("<metadata ");
  expect(metadata).toBeGreaterThan(resource.data.length);
  const prelude = new SvgInputPrelude();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Preserve the native string search boundary.
  const indexOf = String.prototype.indexOf;
  let searched = 0;
  const searches = vi.spyOn(String.prototype, "indexOf").mockImplementation(function (
    this: string,
    needle: string,
    start = 0,
  ) {
    const found = indexOf.call(this, needle, start);
    if ([">", '<style id="inkbook-fonts">', '<defs id="inkbook-images">'].includes(needle))
      searched += Math.max(0, (found < 0 ? this.length : found + needle.length) - start);
    return found;
  });
  try {
    for (let offset = 0; offset < metadata; offset += 32 * 1024) {
      const steps = prelude.write(svg.slice(offset, Math.min(metadata, offset + 32 * 1024)));
      expect(steps.next()).toEqual({ done: true, value: { ok: true, value: null } });
    }
    expect(searched).toBeLessThanOrEqual(metadata * 4);
  } finally {
    searches.mockRestore();
    serializer.clear();
  }
  const steps = prelude.write(svg.slice(metadata));
  let complete = steps.next();
  while (!complete.done) complete = steps.next();
  expect(complete.value.ok && complete.value.value?.prelude.imageResources).toEqual([resource]);
});
