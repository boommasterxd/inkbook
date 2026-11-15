import { afterEach, expect, it, vi } from "vitest";
import { imageElement } from "../../fixtures/domain/images";
import { rasterResource } from "../../fixtures/persistence/image-svg";
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

afterEach(() => vi.restoreAllMocks());

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
  const image = {
    ...imageElement(),
    assetId: resource.id,
    crop: { x: 0, y: 0, width: 1, height: 1 },
  };
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
