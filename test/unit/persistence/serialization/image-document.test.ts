import { expect, it } from "vitest";
import { applyImageCrop } from "../../../../src/domain/images/image-crop";
import { rasterImage, rasterResource } from "../../../fixtures/persistence/image-svg";
import { createSnapshot } from "./fixtures";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/document-codec";
import { IncrementalDocumentSerializer } from "../../../../src/persistence/serialization/output/incremental-document-serializer";
import { parseInkbookDocumentForTest } from "../../../fixtures/persistence/parse-document";
import { matchesCanonicalImageOutput } from "../../../../src/persistence/serialization/output/font-output-binding";
import { ChunkedInkbookInputParser } from "../../../../src/persistence/serialization/input/chunked-input-codec";

it("round-trips one raster payload shared by independently cropped and rotated instances", async () => {
  const resource = rasterResource();
  const image = rasterImage(resource);
  const rotated = {
    ...image,
    id: "00000000-0000-4000-8000-000000000011",
    rotation: 90,
  };
  const crop = { x: 0.25, y: 0, width: 0.5, height: 0.5 };
  const second = applyImageCrop(rotated, crop);
  expect(second).toMatchObject({
    assetId: resource.id,
    crop,
    x: 175,
    y: 225,
    width: 100,
    height: 50,
    pivot: { x: 225, y: 250 },
    rotation: 90,
  });
  expect(applyImageCrop(second, image.crop)).toEqual(rotated);
  const snapshot = {
    ...createSnapshot([image, second]),
    version: 5 as const,
    imageResources: [resource],
  };
  const output = serializeInkbookDocument(snapshot);
  expect(output.ok, JSON.stringify(output)).toBe(true);
  if (!output.ok) return;
  expect(output.value.svg.split(resource.data)).toHaveLength(2);
  expect(await matchesCanonicalImageOutput(output.value.svg, [], [resource], () => undefined)).toBe(
    true,
  );
  const parsed = await parseInkbookDocumentForTest(output.value.svg);
  expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
  if (parsed.ok) expect(parsed.value.snapshot).toEqual(snapshot);
  const safe = new ChunkedInkbookInputParser({ staticValidation: "safe" });
  expect((await safe.write(new TextEncoder().encode(output.value.svg))).ok).toBe(true);
  expect((await safe.finish()).ok).toBe(true);
  expect(
    await matchesCanonicalImageOutput(
      output.value.svg.replace(resource.data, "AAAA"),
      [],
      [resource],
      () => undefined,
    ),
  ).toBe(false);
  const serializer = new IncrementalDocumentSerializer();
  expect(serializer.reset(snapshot)).toEqual({ ok: true, value: undefined });
  const incremental = await serializer.serializeChunked();
  expect(incremental.ok, JSON.stringify(incremental)).toBe(true);
  if (incremental.ok) expect(incremental.value.svg).toEqual(output.value.svg);
  expect(
    serializer.applyDelta({
      baseModelRevision: 7,
      modelRevision: 8,
      removedIds: [image.id, second.id],
    }).ok,
  ).toBe(true);
  const removed = serializer.serialize();
  expect(removed.ok).toBe(true);
  if (removed.ok) {
    expect(removed.value.snapshot.version).toBe(1);
    expect(removed.value.svg).not.toContain(resource.data);
    expect(removed.value.svg).not.toContain("inkbook-images-band");
  }
});
