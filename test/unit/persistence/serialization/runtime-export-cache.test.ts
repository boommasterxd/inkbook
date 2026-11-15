import { afterEach, describe, expect, it, vi } from "vitest";

import type { InkSnapshotV1 } from "../../../../src/domain/schema/public";
import { BackgroundFragmentCache } from "../../../../src/persistence/serialization/output/background";
import { buildElementFragments } from "../../../../src/persistence/serialization/output/element-fragments";
import { ElementFragmentCache } from "../../../../src/persistence/serialization/output/element-fragment-cache";
import {
  IncrementalDocumentSerializer,
  serializeInkbookDocument,
} from "../../../../src/persistence/serialization/public";
import { createAllElementSnapshot, createDottedRectangleSnapshot } from "./fixtures";

import { createTestStroke } from "../../../fixtures/persistence/worker-snapshot";
import { StrokeShapeCache } from "../../../../src/persistence/serialization/output/stroke-shape-cache";
import { StrokeSampleEncodingCache } from "../../../../src/persistence/serialization/metadata/stroke-sample-encoding-cache";

afterEach(() => vi.restoreAllMocks());

describe("runtime export cache reuse", () => {
  it.each(["none", "lines", "squares", "dots"] as const)(
    "preserves cold and warm %s document bytes and hashes across resets",
    async (type) => {
      const snapshot = createAllElementSnapshot();
      snapshot.page.background = type === "none" ? { type } : { type, spacing: 25 };
      const serializer = new IncrementalDocumentSerializer();
      expect(serializer.resetRuntime(snapshot).ok).toBe(true);

      await expectEquivalentExport(serializer, snapshot);
      const first = serializer.instrumentation;
      await expectEquivalentExport(serializer, snapshot);
      expect(serializer.resetRuntime(structuredClone(snapshot)).ok).toBe(true);
      await expectEquivalentExport(serializer, snapshot);

      expect(serializer.instrumentation).toMatchObject({
        backgroundBuilds: 1,
        fragmentBuilds: first.fragmentBuilds,
        cacheBytes: first.cacheBytes,
      });
      serializer.clear();
      expect(serializer.instrumentation.cacheBytes).toBe(0);
      expect(serializer.resetRuntime(snapshot).ok).toBe(true);
      await expectEquivalentExport(serializer, snapshot);
      expect(serializer.instrumentation.backgroundBuilds).toBe(2);
    },
  );

  it("rebuilds backgrounds for page changes and changed element extents", async () => {
    const serializer = new IncrementalDocumentSerializer();
    const first = createDottedRectangleSnapshot(100);
    expect(serializer.resetRuntime(first).ok).toBe(true);
    await expectEquivalentExport(serializer, first);

    const taller = createDottedRectangleSnapshot(20_000);
    const spaced = structuredClone(taller);
    spaced.page.background = { type: "dots", spacing: 50 };
    for (const [index, snapshot] of [taller, spaced, first].entries()) {
      expect(
        serializer.applyDelta({
          baseModelRevision: first.revision + index,
          modelRevision: first.revision + index + 1,
          changedElements: snapshot.elements,
          page: snapshot.page,
        }).ok,
      ).toBe(true);
      await expectEquivalentExport(serializer, {
        ...snapshot,
        revision: first.revision + index + 1,
      });
      expect(serializer.instrumentation.backgroundBuilds).toBe(index + 2);
    }
  });
});

it("resolves unchanged fragments synchronously and slices only replaced elements", async () => {
  const snapshot = createAllElementSnapshot();
  const serializer = new IncrementalDocumentSerializer();
  expect(serializer.resetRuntime(snapshot).ok).toBe(true);
  const resolve = vi.spyOn(ElementFragmentCache.prototype, "resolveSliced");
  await serializer.serializeRuntimeChunked({});
  expect(resolve).toHaveBeenCalledTimes(snapshot.elements.length);
  resolve.mockClear();
  const metadata = new Set(
    snapshot.elements.map((element) => buildElementFragments(element).metadata),
  );
  const encode = vi.spyOn(TextEncoder.prototype, "encode");
  const hitsPerCheckpoint: number[] = [];
  let previousHits = serializer.instrumentation.fragmentHits;
  const checkpoint = () => {
    const hits = serializer.instrumentation.fragmentHits;
    if (hits > previousHits) hitsPerCheckpoint.push(hits - previousHits);
    previousHits = hits;
    return undefined;
  };

  expect((await serializer.serializeRuntimeChunked({ checkpoint })).ok).toBe(true);
  expect(resolve).not.toHaveBeenCalled();
  expect(hitsPerCheckpoint).toEqual(Array<number>(snapshot.elements.length).fill(1));
  expect(
    encode.mock.calls.filter(([value]) => value !== undefined && metadata.has(value)),
  ).toHaveLength(0);
  const original = snapshot.elements.find((element) => element.kind === "rectangle")!;
  const changed = { ...original, style: { ...original.style, outlineOpacity: 0.25 } };
  expect(
    serializer.applyDelta({
      baseModelRevision: snapshot.revision,
      modelRevision: snapshot.revision + 1,
      changedElements: [changed],
    }).ok,
  ).toBe(true);
  await expectEquivalentExport(serializer, {
    ...snapshot,
    revision: snapshot.revision + 1,
    elements: snapshot.elements.map((element) => (element.id === changed.id ? changed : element)),
  });
  expect(resolve).toHaveBeenCalledOnce();
  expect(resolve.mock.calls[0]![0].element.id).toBe(changed.id);
  serializer.clear();
  expect(serializer.instrumentation).toMatchObject({ cacheBytes: 0, cacheElements: 0 });
});

describe("runtime export cache cancellation and budgets", () => {
  it("preserves cancellation checkpoints and reusable state during a warm export", async () => {
    const snapshot = createAllElementSnapshot();
    const serializer = new IncrementalDocumentSerializer();
    expect(serializer.resetRuntime(snapshot).ok).toBe(true);
    await expectEquivalentExport(serializer, snapshot);
    const warm = serializer.instrumentation;
    const controller = new AbortController();
    let checkpoints = 0;

    await expect(
      serializer.serializeRuntimeChunked({
        checkpoint: async () => {
          checkpoints += 1;
          controller.abort();
        },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(checkpoints).toBe(1);
    await expectEquivalentExport(serializer, snapshot);
    expect(serializer.instrumentation).toMatchObject({
      backgroundBuilds: warm.backgroundBuilds,
      fragmentBuilds: warm.fragmentBuilds,
      cacheBytes: warm.cacheBytes,
    });
  });

  it("still enforces a reduced background budget on a cache hit", () => {
    const cache = new BackgroundFragmentCache();
    const page = createDottedRectangleSnapshot(100).page;
    const background = cache.resolve(page, 1000, 1024 * 1024);
    expect(background).not.toBeNull();
    expect(cache.resolve(page, 1000, background!.length)).toBe(background);
    expect(cache.resolve(page, 1000, background!.length - 1)).toBeNull();
    expect(cache.builds).toBe(1);
  });

  it("rejects over-limit backgrounds after a successful cached export", async () => {
    const serializer = new IncrementalDocumentSerializer();
    expect(serializer.resetRuntime(createDottedRectangleSnapshot(100)).ok).toBe(true);
    expect((await serializer.serializeRuntimeChunked({})).ok).toBe(true);
    expect(serializer.resetRuntime(createDottedRectangleSnapshot(550_000)).ok).toBe(true);

    expect(await serializer.serializeRuntimeChunked({})).toMatchObject({
      ok: false,
      error: { code: "static-output-limit-exceeded" },
    });
    expect(serializer.instrumentation.backgroundBuilds).toBe(1);
  });
});

async function expectEquivalentExport(
  serializer: IncrementalDocumentSerializer,
  snapshot: InkSnapshotV1,
): Promise<void> {
  const expected = serializeInkbookDocument(snapshot);
  const actual = await serializer.serializeRuntimeChunked({ sliceByteLimit: 31 });
  if (!expected.ok || !actual.ok) throw new Error("Expected successful exports.");
  expect(new TextDecoder().decode(actual.value.svg)).toBe(expected.value.svg);
  expect(actual.value.hash).toBe(expected.value.hash);
  expect(actual.value.snapshotHash).toBe(expected.value.snapshotHash);
  expect(actual.value.totalBytes).toBe(expected.value.totalBytes);
  expect(actual.value.metadataBytes).toBe(expected.value.metadataBytes);
}

describe("cached Auto presentation", () => {
  it("keeps ordinary exports unchanged and remembers a fixed-color element needs no Auto plan", async () => {
    const options = autoFragmentOptions();
    options.element.style.color = { type: "rgba", value: "#123456FF" };
    const cache = new ElementFragmentCache();
    const ordinary = await cache.resolveSliced({ ...options, auto: false });
    expect(ordinary.fragments.autoPresentation).toBeUndefined();
    const fixed = await cache.resolveSliced(options);
    expect(fixed.fragments.autoPresentation).toBeNull();
    expect(fixed.fragments.retainedBytes).toBe(ordinary.fragments.retainedBytes);
    expect(fixed.fragments.svgUtf8).toBe(ordinary.fragments.svgUtf8);
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    expect((await cache.resolveSliced(options)).fragments).toBe(fixed.fragments);
    expect(decode).not.toHaveBeenCalled();
  });

  it("retains shared contour buffers and adopts the plan only for matching canonical elements", async () => {
    const options = autoFragmentOptions();
    const cache = new ElementFragmentCache();
    const { fragments } = await cache.resolveSliced(options);
    const plan = fragments.autoPresentation!;
    expect(plan.chunks.some((chunk) => chunk.buffer === fragments.svgUtf8.buffer)).toBe(true);
    const wrappers = plan.chunks.filter((chunk) => chunk.buffer !== fragments.svgUtf8.buffer);
    expect(plan.retainedBytes).toBe(
      128 +
        plan.chunks.length * 64 +
        plan.servers.length * 512 +
        wrappers.reduce((sum, chunk) => sum + chunk.byteLength, 0),
    );
    expect(cache.retainedBytes).toBe(fragments.retainedBytes);
    expect((await cache.resolveSliced(options)).fragments).toBe(fragments);
    const adopted = structuredClone(options.element);
    const reset = cache.prepareResetSteps(new Map([[adopted.id, adopted]]), false);
    let step = reset.next();
    while (!step.done) step = reset.next();
    expect(step.value.current(adopted)?.autoPresentation).toBe(plan);
    step.value.adopt({ ...adopted, rotation: 1 });
    expect(step.value.size).toBe(0);
    cache.clear();
    expect(cache.retainedBytes).toBe(0);
  });

  it.each(["cancelled", "stale"])("does not publish a %s plan after a checkpoint", async (mode) => {
    const options = autoFragmentOptions();
    const cache = new ElementFragmentCache();
    const original = buildElementFragments(options.element);
    cache.replace(original.element.id, original);
    const controller = new AbortController();
    let current = true;
    await expect(
      cache.resolveSliced({
        ...options,
        assembly: {
          signal: controller.signal,
          checkpoint: () => {
            if (mode === "cancelled") controller.abort();
            current = false;
            return undefined;
          },
        },
        isCurrent: () => current,
      }),
    ).rejects.toThrow();
    expect(cache.current(options.element)).toBe(original);
    expect(original.autoPresentation).toBeUndefined();
    expect(cache.retainedBytes).toBe(original.retainedBytes);
  });

  it("charges Auto buffers to the same byte cap and evicts at the existing entry cap", () => {
    const cache = new ElementFragmentCache();
    const fragment = buildElementFragments(createTestStroke());
    for (let index = 0; index <= 20_000; index++) cache.replace(String(index), fragment);
    expect(cache.size).toBe(20_000);
    expect([...cache.ids()][0]).toBe("1");
    const owned = new Uint8Array(64 * 1024 * 1024);
    const autoPresentation = {
      chunks: [owned],
      servers: [],
      bytes: owned.byteLength,
      retainedBytes: owned.byteLength + 192,
    };
    const oversized = {
      ...fragment,
      autoPresentation,
      retainedBytes: fragment.retainedBytes + autoPresentation.retainedBytes,
    };
    cache.retainIfSpace(fragment.element.id, oversized);
    expect(cache.size).toBe(20_000);
    cache.replace(fragment.element.id, oversized);
    expect(cache.size).toBe(0);
    expect(cache.retainedBytes).toBe(0);
  });
});

function autoFragmentOptions() {
  return {
    element: createTestStroke(),
    bottom: 0,
    shapeCache: new StrokeShapeCache(),
    sampleCache: new StrokeSampleEncodingCache(),
    assembly: {},
    auto: true,
    isCurrent: () => true,
  };
}
