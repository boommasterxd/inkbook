import { expect, it, vi } from "vitest";
import { ChunkedInkbookInputParser } from "../../../src/persistence/serialization/chunked-input-codec";
import {
  IncrementalDocumentSerializer,
  serializeInkbookDocument,
} from "../../../src/persistence/serialization/public";
import * as sampleCodec from "../../../src/persistence/serialization/stroke-sample-codec";
import { adoptTransferredStrokeSamples } from "../../../src/persistence/worker/runtime/runtime-elements";
import { createStandardPersistenceFixture } from "./fixtures";
import type { InkSnapshotV1 } from "../../../src/domain/schema/public";
import { elementRenderBand } from "../../../src/persistence/serialization/element-fragments";

async function deleteAndRestore(
  serializer: IncrementalDocumentSerializer,
  snapshot: InkSnapshotV1,
) {
  const retained = serializer.instrumentation.sampleEncodingCacheBytes;
  expect(
    serializer.applyDelta(
      {
        baseModelRevision: snapshot.revision,
        modelRevision: snapshot.revision + 1,
        removedIds: snapshot.elements.map((element) => element.id),
      },
      true,
    ).ok,
  ).toBe(true);
  expect(serializer.currentElementCount()).toBe(0);
  expect(serializer.instrumentation).toMatchObject({
    cacheElements: 0,
    sampleEncodingCacheElements: 10_000,
    sampleEncodingCacheBytes: retained,
  });
  expect((await serializer.serializeRuntimeChunked({})).ok).toBe(true);
  expect(
    serializer.applyDelta(
      {
        baseModelRevision: snapshot.revision + 1,
        modelRevision: snapshot.revision + 2,
        changedElements: snapshot.elements,
        orderChanges: {
          content: snapshot.elements
            .filter((element) => elementRenderBand(element) === "content")
            .map((element) => element.id),
          highlight: snapshot.elements
            .filter((element) => elementRenderBand(element) === "highlight")
            .map((element) => element.id),
        },
      },
      true,
    ).ok,
  ).toBe(true);
  expect((await serializer.serializeRuntimeChunked({})).ok).toBe(true);
  expect(serializer.currentElementCount()).toBe(snapshot.elements.length);
  expect(serializer.instrumentation.sampleEncodingBuilds).toBe(0);
}

it("avoids encoding point reads on cold loaded export and header changes across 10,000 strokes", async () => {
  const fixture = createStandardPersistenceFixture();
  const disk = serializeInkbookDocument(fixture);
  if (!disk.ok) throw new Error(disk.error.code);
  const serializer = new IncrementalDocumentSerializer();
  const parser = new ChunkedInkbookInputParser({
    sampleEncodingCache: serializer.sampleEncodingCache,
    staticValidation: "safe",
  });
  await parser.write(new TextEncoder().encode(disk.value.svg));
  const parsed = await parser.finish();
  if (!parsed.ok) throw new Error(parsed.error.code);
  expect(
    serializer.resetValidatedRuntime(parsed.value.snapshot, parsed.value.derivations, true).ok,
  ).toBe(true);
  expect(serializer.instrumentation.sampleEncodingCacheElements).toBe(10_000);
  const encode = sampleCodec.encodeStrokeSamplesSteps;
  let pointReads = 0;
  const probe = vi
    .spyOn(sampleCodec, "encodeStrokeSamplesSteps")
    .mockImplementation((points, signal) =>
      encode(
        new Proxy(points, {
          get(target, key) {
            if (typeof key === "string" && /^\d+$/.test(key)) pointReads += 1;
            return Reflect.get(target, key, target) as unknown;
          },
        }),
        signal,
      ),
    );
  try {
    const cold = await serializer.serializeRuntimeChunked({});
    if (!cold.ok) throw new Error(cold.error.code);
    expect(cold.value.hash).toBe(disk.value.hash);
    expect(pointReads).toBe(0);
    await deleteAndRestore(serializer, parsed.value.snapshot);
    expect(pointReads).toBe(0);
    const first = parsed.value.snapshot.elements.find((element) => element.kind === "stroke")!;
    const moved = { ...first, offset: { x: 10, y: 10 }, style: { ...first.style, opacity: 0.5 } };
    expect(
      serializer.applyDelta(
        {
          baseModelRevision: fixture.revision + 2,
          changedElements: [moved],
          modelRevision: fixture.revision + 3,
        },
        true,
      ).ok,
    ).toBe(true);
    expect((await serializer.serializeRuntimeChunked({})).ok).toBe(true);
    expect(pointReads).toBe(0);
    const points = new Float64Array(first.points);
    points[0] = points[0]! + 0.001;
    expect(
      serializer.applyDelta(
        {
          baseModelRevision: fixture.revision + 3,
          changedElements: [{ ...moved, points: adoptTransferredStrokeSamples(points) }],
          modelRevision: fixture.revision + 4,
        },
        true,
      ).ok,
    ).toBe(true);
    expect(pointReads).toBe(0);
    expect((await serializer.serializeRuntimeChunked({})).ok).toBe(true);
    expect(pointReads).toBe(points.length);
    expect(
      serializer.applyDelta(
        {
          baseModelRevision: fixture.revision + 4,
          changedElements: [first],
          modelRevision: fixture.revision + 5,
        },
        true,
      ).ok,
    ).toBe(true);
    expect(pointReads).toBe(points.length);
    expect((await serializer.serializeRuntimeChunked({})).ok).toBe(true);
    expect(pointReads).toBe(points.length + first.points.length);
    expect(serializer.instrumentation.sampleEncodingCacheBytes).toBeLessThanOrEqual(
      32 * 1024 * 1024,
    );
    serializer.clear();
    expect(serializer.instrumentation.sampleEncodingCacheBytes).toBe(0);
  } finally {
    probe.mockRestore();
    serializer.clear();
  }
}, 120_000);
