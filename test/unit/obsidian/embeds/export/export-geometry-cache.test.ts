import { expect, it, vi } from "vitest";
import {
  ExportGeometryCache,
  EXPORT_GEOMETRY_CACHE_LIMITS,
  type CachedExportGeometry,
} from "../../../../../src/obsidian/embeds/export/export-geometry-cache";
import { prepareExportCutsSteps } from "../../../../../src/domain/export/export-pagination";
import { finishGeometrySteps } from "../../../../fixtures/domain/geometry-steps";
import { exportDescriptor } from "../../../../fixtures/obsidian/markdown-export";

const signal = () => new AbortController().signal;

function geometry(): CachedExportGeometry {
  return {
    cuts: finishGeometrySteps(prepareExportCutsSteps([{ minY: 20, maxY: 40 }])),
    fragments: [{ minY: 20, maxY: 40, background: false }],
  };
}

function deferredGeometry() {
  let resolve!: (value: CachedExportGeometry) => void;
  const promise = new Promise<CachedExportGeometry>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

it("lazily reuses completed geometry for the complete validated content identity", async () => {
  const cache = new ExportGeometryCache();
  const prepared = geometry();
  const prepare = vi.fn(async () => prepared);
  expect(cache.instrumentation).toEqual({ entries: 0, numericBytes: 0 });
  const descriptor = exportDescriptor();
  expect(await cache.prepare(descriptor, prepare, signal())).toBe(prepared);
  const sameContent = { ...descriptor, contentIdentity: { ...descriptor.contentIdentity } };
  const warm = await cache.prepare(sameContent, prepare, signal());
  expect(warm.cuts).toBe(prepared.cuts);
  expect(warm.fragments).toBe(prepared.fragments);
  expect(prepare).toHaveBeenCalledOnce();
  await cache.prepare(
    {
      ...descriptor,
      contentIdentity: { ...descriptor.contentIdentity, outputHash: `${"a".repeat(63)}b` },
    },
    prepare,
    signal(),
  );
  await cache.prepare(
    {
      ...descriptor,
      contentIdentity: { ...descriptor.contentIdentity, revision: 8 },
    },
    prepare,
    signal(),
  );
  expect(prepare).toHaveBeenCalledTimes(3);
  expect(cache.instrumentation.entries).toBe(3);
});

it("evicts the least recently used completed entry at the entry limit", async () => {
  const cache = new ExportGeometryCache();
  const prepare = vi.fn(async () => geometry());
  const descriptors = Array.from(
    { length: EXPORT_GEOMETRY_CACHE_LIMITS.entries + 1 },
    (_, index) => ({
      ...exportDescriptor(),
      contentIdentity: { outputHash: index.toString(16).padStart(64, "0"), revision: 1 },
    }),
  );
  for (const descriptor of descriptors.slice(0, -1))
    await cache.prepare(descriptor, prepare, signal());
  await cache.prepare(descriptors[0]!, prepare, signal());
  await cache.prepare(descriptors[descriptors.length - 1]!, prepare, signal());
  expect(cache.instrumentation.entries).toBe(EXPORT_GEOMETRY_CACHE_LIMITS.entries);
  prepare.mockClear();
  await cache.prepare(descriptors[0]!, prepare, signal());
  expect(prepare).not.toHaveBeenCalled();
  await cache.prepare(descriptors[1]!, prepare, signal());
  expect(prepare).toHaveBeenCalledOnce();
});

it.each(["cuts", "fragments"] as const)(
  "does not retain a %s fallback or a failed operation",
  async (missing) => {
    const cache = new ExportGeometryCache();
    const descriptor = exportDescriptor();
    const prepare = vi.fn(async () => ({ ...geometry(), [missing]: undefined }));
    await cache.prepare(descriptor, prepare, signal());
    await cache.prepare(descriptor, prepare, signal());
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(cache.instrumentation.entries).toBe(0);
    await expect(
      cache.prepare(
        descriptor,
        async () => {
          throw new Error("Unavailable geometry.");
        },
        signal(),
      ),
    ).rejects.toThrow("Unavailable geometry.");
    expect(cache.instrumentation.entries).toBe(0);
  },
);

it("does not publish an operation completed after cancellation and permits a fresh export", async () => {
  const cache = new ExportGeometryCache();
  const descriptor = exportDescriptor();
  const abort = new AbortController();
  const deferred = deferredGeometry();
  const pending = cache.prepare(descriptor, () => deferred.promise, abort.signal);
  abort.abort();
  deferred.resolve(geometry());
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(cache.instrumentation.entries).toBe(0);
  const prepare = vi.fn(async () => geometry());
  await cache.prepare(descriptor, prepare, signal());
  await expect(cache.prepare(descriptor, prepare, abort.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(prepare).toHaveBeenCalledOnce();
});

it("drops retained and late values on disposal without starting more export work", async () => {
  const cache = new ExportGeometryCache();
  const descriptor = exportDescriptor();
  await cache.prepare(descriptor, async () => geometry(), signal());
  const deferred = deferredGeometry();
  const changed = {
    ...descriptor,
    contentIdentity: { ...descriptor.contentIdentity, revision: 8 },
  };
  const pending = cache.prepare(changed, () => deferred.promise, signal());
  cache.dispose();
  deferred.resolve(geometry());
  await expect(pending).resolves.toEqual({ cuts: undefined, fragments: undefined });
  const prepare = vi.fn(async () => geometry());
  await cache.prepare(descriptor, prepare, signal());
  expect(prepare).not.toHaveBeenCalled();
  cache.dispose();
  expect(cache.instrumentation).toEqual({ entries: 0, numericBytes: 0 });
});
