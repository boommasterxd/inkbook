import { afterEach, describe, expect, it, vi } from "vitest";

import type { InkSnapshotV1 } from "../../../../src/domain/schema/public";
import { BackgroundFragmentCache } from "../../../../src/persistence/serialization/output/background";
import { buildElementFragments } from "../../../../src/persistence/serialization/output/element-fragments";
import {
  IncrementalDocumentSerializer,
  serializeInkbookDocument,
} from "../../../../src/persistence/serialization/public";
import { createAllElementSnapshot, createDottedRectangleSnapshot } from "./fixtures";

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

  it("uses cached metadata byte counts without encoding each warm fragment to count it", async () => {
    const snapshot = createAllElementSnapshot();
    const serializer = new IncrementalDocumentSerializer();
    expect(serializer.resetRuntime(snapshot).ok).toBe(true);
    await serializer.serializeRuntimeChunked({});
    const metadata = new Set(
      snapshot.elements.map((element) => buildElementFragments(element).metadata),
    );
    const encode = vi.spyOn(TextEncoder.prototype, "encode");

    expect((await serializer.serializeRuntimeChunked({})).ok).toBe(true);
    expect(
      encode.mock.calls.filter(([value]) => value !== undefined && metadata.has(value)),
    ).toHaveLength(0);
  });
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
