import { expect, it, vi } from "vitest";
import {
  MAX_PREPARED_SCENE_PATH_BYTES,
  MAX_PREPARED_SCENE_PATH_IDS,
} from "../../../../src/domain/geometry/prepared-scene-paths";
import { DocumentPathPreparation } from "../../../../src/rendering/scene/document-path-preparation";
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import {
  completeDocumentPaths,
  createDocumentPathFixture,
  deferDocumentPaths,
  pauseDocumentPaths,
} from "../../../fixtures/rendering/document-path-preparation";

it("walks the current band order lazily and skips cached contours without local construction", async () => {
  const fixture = createDocumentPathFixture(3);
  const { preparation, domain, store, cache, work, prepare, elements } = fixture;
  const cached = [{ d: "M0 0L1 1", paint: "stroke" as const }];
  cache.retain(elements[0]!.id, store.get(elements[0]!.id)!.geometryVersion, cached);
  const localBuild = vi.spyOn(cache, "startPreparation");
  expect(work.orderReads).toBe(0);
  await completeDocumentPaths(fixture);
  expect(prepare).toHaveBeenCalledOnce();
  expect(prepare.mock.calls[0]![0]).toEqual(elements.slice(1).map(({ id }) => id));
  expect(work).toEqual({ orderReads: 3, builds: 2 });
  expect(localBuild).not.toHaveBeenCalled();
  expect(domain.instrumentation.snapshotMaterializations).toBe(0);
  expect(domain.instrumentation.bandScans).toBe(0);
  expect(preparation.memoryUsage()).toBe(0);
  expect(cache.has(elements[2]!.id, store.get(elements[2]!.id)!.geometryVersion)).toBe(true);
  preparation.release();
  store.release();
});

it("respects the injected deadline for lazy record admission and leaves no polling while pending", () => {
  const fixture = createDocumentPathFixture();
  const remote = deferDocumentPaths(fixture);
  let time = 0;
  const get = fixture.store.get.bind(fixture.store);
  vi.spyOn(fixture.store, "get").mockImplementation((id) => {
    time += 1;
    return get(id);
  });
  expect(fixture.preparation.prepare(1, () => time)).toBe(false);
  expect(fixture.work.orderReads).toBe(1);
  expect(remote.observer().speculative).toBe(true);
  expect(remote.observer().navigationReserve).toBe(false);
  for (let call = 0; call < 10; call++)
    expect(fixture.preparation.prepare(Infinity, () => 0)).toBe(false);
  expect(fixture.work.orderReads).toBe(1);
  fixture.preparation.release();
  expect(remote.signal().aborted).toBe(true);
  expect(fixture.preparation.memoryUsage()).toBe(0);
  fixture.store.release();
});

it("preserves cursor progress through input cancellation and rejects late worker delivery", async () => {
  const fixture = createDocumentPathFixture(MAX_PREPARED_SCENE_PATH_IDS + 1);
  const remote = deferDocumentPaths(fixture);
  const path = { id: fixture.elements[0]!.id, parts: [{ d: "M0 0", paint: "fill" as const }] };
  fixture.preparation.prepare(Infinity, () => 0);
  expect(fixture.work.orderReads).toBe(MAX_PREPARED_SCENE_PATH_IDS);
  remote.observer().onProgress([path]);
  fixture.ready.mockClear();
  pauseDocumentPaths(fixture, remote.signal());
  fixture.preparation.pause();
  const late = { ...path, id: fixture.elements[1]!.id };
  remote.observer().onProgress([path, late]);
  remote.finish([path, late]);
  await Promise.resolve();
  expect(fixture.ready).not.toHaveBeenCalled();
  expect(fixture.cache.has(path.id, fixture.store.get(path.id)!.geometryVersion)).toBe(false);
  fixture.store.prepareScenePaths = fixture.prepare;
  await completeDocumentPaths(fixture);
  expect(fixture.work.orderReads).toBe(MAX_PREPARED_SCENE_PATH_IDS + 1);
  expect(fixture.work.builds).toBe(MAX_PREPARED_SCENE_PATH_IDS);
  expect(fixture.prepare.mock.calls.flatMap(([ids]) => ids)).not.toContain(path.id);
  expect(fixture.cache.has(path.id, fixture.store.get(path.id)!.geometryVersion)).toBe(true);
  fixture.preparation.release();
  fixture.store.release();
});

it.each(["geometry", "delete", "paint"] as const)(
  "invalidates only the affected delivered contour after a paused %s change",
  async (change) => {
    const fixture = createDocumentPathFixture();
    const remote = deferDocumentPaths(fixture);
    fixture.preparation.prepare(Infinity, () => 0);
    remote
      .observer()
      .onProgress(
        fixture.elements.map(({ id }) => ({ id, parts: [{ d: "M0 0", paint: "fill" as const }] })),
      );
    fixture.preparation.pause();
    const element = fixture.elements[1]!;
    if (change === "delete") fixture.domain.remove([element.id]);
    else if (change === "geometry")
      fixture.domain.replace(element.id, { ...element, style: { ...element.style, width: 4 } });
    fixture.preparation.invalidate({
      affected: [
        {
          id: element.id,
          domains: [change === "delete" ? "geometry" : change],
          ...(change === "delete" ? { after: null } : {}),
        },
      ],
    });
    fixture.store.prepareScenePaths = fixture.prepare;
    await completeDocumentPaths(fixture);
    expect(fixture.prepare.mock.calls.flatMap(([ids]) => ids)).toEqual(
      change === "geometry" ? [element.id] : [],
    );
    for (const unchanged of [fixture.elements[0]!, fixture.elements[2]!])
      expect(
        fixture.cache.has(unchanged.id, fixture.store.get(unchanged.id)!.geometryVersion),
      ).toBe(true);
    expect(fixture.preparation.memoryUsage()).toBe(0);
    fixture.preparation.release();
    fixture.store.release();
  },
);

it("adopts retained delivery only within the admitted deadline and releases it without late callbacks", async () => {
  const fixture = createDocumentPathFixture();
  const remote = deferDocumentPaths(fixture);
  fixture.preparation.prepare(Infinity, () => 0);
  const paths = fixture.elements.map(({ id }) => ({
    id,
    parts: [{ d: "M0 0", paint: "fill" as const }],
  }));
  remote.observer().onProgress(paths);
  const get = vi.spyOn(fixture.store, "get");
  const adopt = vi.spyOn(fixture.cache, "retainSpeculative");
  fixture.ready.mockClear();
  fixture.preparation.pause();
  expect(get).not.toHaveBeenCalled();
  expect(fixture.preparation.prepare(0, () => 0)).toBe(true);
  expect(adopt).not.toHaveBeenCalled();
  let time = 0;
  expect(fixture.preparation.prepare(1, () => time++)).toBe(true);
  expect(adopt).toHaveBeenCalledOnce();
  fixture.preparation.release();
  expect(fixture.preparation.memoryUsage()).toBe(0);
  remote.observer().onProgress(paths);
  remote.finish(paths);
  await Promise.resolve();
  expect(fixture.ready).not.toHaveBeenCalled();
  expect(fixture.preparation.prepare(Infinity, () => 0)).toBe(false);
  expect(adopt).toHaveBeenCalledOnce();
  fixture.store.release();
});

it("drops a retained contour when it becomes stale without a delivered mutation delta", async () => {
  const fixture = createDocumentPathFixture(1);
  const remote = deferDocumentPaths(fixture);
  fixture.preparation.prepare(Infinity, () => 0);
  const element = fixture.elements[0]!;
  remote.observer().onProgress([{ id: element.id, parts: [{ d: "M0 0", paint: "fill" }] }]);
  fixture.preparation.pause();
  fixture.domain.replace(element.id, { ...element, style: { ...element.style, width: 4 } });
  fixture.store.prepareScenePaths = fixture.prepare;
  await completeDocumentPaths(fixture);
  expect(fixture.prepare.mock.calls.map(([ids]) => ids)).toEqual([[element.id]]);
  expect(fixture.cache.has(element.id, fixture.store.get(element.id)!.geometryVersion)).toBe(true);
  fixture.preparation.release();
  fixture.store.release();
});

it("prepares only changed geometry after the completed file walk", async () => {
  const fixture = createDocumentPathFixture();
  await completeDocumentPaths(fixture);
  fixture.prepare.mockClear();
  const element = fixture.elements[1]!;
  const changed = { ...element, style: { ...element.style, width: 4 as const } };
  fixture.domain.replace(element.id, changed);
  fixture.preparation.invalidate({ affected: [{ id: element.id, domains: ["geometry"] }] });
  await completeDocumentPaths(fixture);
  expect(fixture.prepare).toHaveBeenCalledOnce();
  expect(fixture.prepare.mock.calls[0]![0]).toEqual([element.id]);
  expect(fixture.work.orderReads).toBe(3);
  fixture.prepare.mockClear();
  fixture.preparation.invalidate({ affected: [{ id: element.id, domains: ["paint", "order"] }] });
  await completeDocumentPaths(fixture);
  expect(fixture.prepare).not.toHaveBeenCalled();
  fixture.preparation.release();
  fixture.store.release();
});

it("rejects stale geometry and resumes from a fresh cursor after structural mutation", async () => {
  const fixture = createDocumentPathFixture(2);
  const remote = deferDocumentPaths(fixture);
  const element = fixture.elements[0]!;
  fixture.preparation.prepare(Infinity, () => 0);
  fixture.domain.remove([element.id]);
  remote.observer().onProgress([{ id: element.id, parts: [{ d: "M0 0", paint: "fill" }] }]);
  expect(fixture.preparation.prepare(Infinity, () => 0)).toBe(false);
  expect(fixture.cache.statistics().entries).toBe(0);
  fixture.preparation.invalidate({
    affected: [{ id: element.id, after: null, domains: ["geometry", "visibility"] }],
  });
  fixture.store.prepareScenePaths = fixture.prepare;
  await completeDocumentPaths(fixture);
  expect(fixture.work.builds).toBe(1);
  fixture.preparation.release();
  fixture.store.release();
});

it.each(["undefined", "reject", "oversize"] as const)(
  "stops unavailable %s requests without retaining oversized buffers or polling",
  async (cause) => {
    const fixture = createDocumentPathFixture(1);
    const remote = deferDocumentPaths(fixture);
    if (cause === "reject")
      fixture.store.prepareScenePaths = () => Promise.reject(new Error("Unavailable"));
    fixture.preparation.prepare(Infinity, () => 0);
    if (cause === "undefined") remote.finish(undefined);
    if (cause === "oversize") {
      remote.observer().onProgress([
        {
          id: fixture.elements[0]!.id,
          parts: [{ d: "0".repeat(MAX_PREPARED_SCENE_PATH_BYTES / 2), paint: "fill" }],
        },
      ]);
      expect(remote.signal().aborted).toBe(true);
    }
    await Promise.resolve();
    expect(fixture.preparation.prepare(Infinity, () => 0)).toBe(false);
    expect(fixture.preparation.needsWork).toBe(false);
    expect(fixture.cache.statistics().bytes).toBe(0);
    expect(fixture.preparation.memoryUsage()).toBeLessThan(1024);
    fixture.preparation.release();
    expect(fixture.preparation.memoryUsage()).toBe(0);
    fixture.store.release();
  },
);

it("does no work without the worker or order port and never evicts needed cache entries", async () => {
  const cache = new ScenePathCache(1, 4096);
  const fixture = createDocumentPathFixture(2, cache);
  const retained = fixture.elements[0]!.id;
  cache.retain(retained, fixture.store.get(retained)!.geometryVersion, [
    { d: "M0 0", paint: "fill" },
  ]);
  const before = cache.statistics();
  expect(fixture.preparation.prepare(Infinity, () => 0)).toBe(false);
  expect(fixture.work.orderReads).toBe(0);
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(cache.statistics().evictions).toBe(before.evictions);
  expect(cache.has(retained, fixture.store.get(retained)!.geometryVersion)).toBe(true);
  cache.invalidate(retained);
  await completeDocumentPaths(fixture);
  expect(fixture.prepare).toHaveBeenCalledOnce();
  expect(cache.statistics().entries).toBe(1);
  expect(cache.statistics().evictions).toBe(before.evictions);
  const unsupported = new DocumentPathPreparation(
    { get: () => undefined, query: () => undefined },
    new ScenePathCache(),
    vi.fn(),
  );
  expect(unsupported.prepare(Infinity, () => 0)).toBe(false);
  fixture.preparation.release();
  fixture.store.release();
});

it("stops when a nonempty cache budget cannot retain the returned contour", async () => {
  const fixture = createDocumentPathFixture(1, new ScenePathCache(4, 1024));
  const remote = deferDocumentPaths(fixture);
  fixture.preparation.prepare(Infinity, () => 0);
  const maxBytes = remote.observer().maxBytes!;
  const id = fixture.elements[0]!.id;
  const length = Math.floor((maxBytes - 128 - id.length * 2) / 2);
  remote.finish([{ id, parts: [{ paint: "fill", d: "0".repeat(length) }] }]);
  await Promise.resolve();
  expect(fixture.preparation.prepare(Infinity, () => 0)).toBe(false);
  expect(fixture.preparation.needsWork).toBe(false);
  expect(fixture.cache.speculativeCapacityBytes()).toBeGreaterThan(0);
  expect(fixture.cache.statistics().entries).toBe(0);
  expect(fixture.work.orderReads).toBe(1);
  fixture.preparation.release();
  fixture.store.release();
});

it("keeps current cache owners when foreground work consumes a paused contour's spare capacity", async () => {
  const cache = new ScenePathCache(2, 4096);
  const fixture = createDocumentPathFixture(1, cache);
  const remote = deferDocumentPaths(fixture);
  fixture.preparation.prepare(Infinity, () => 0);
  const path = fixture.build([fixture.elements[0]!.id]);
  remote.observer().onProgress(path);
  fixture.preparation.pause();
  const owners = [indexedStroke(1).id, indexedStroke(2).id];
  for (const id of owners) cache.retain(id, 1, [{ d: "M0 0", paint: "fill" }]);
  const before = cache.statistics();
  expect(fixture.preparation.prepare(Infinity, () => 0)).toBe(false);
  expect(fixture.preparation.needsWork).toBe(false);
  expect(cache.statistics()).toEqual(before);
  expect(owners.every((id) => cache.has(id, 1))).toBe(true);
  expect(fixture.preparation.memoryUsage()).toBe(128);
  for (const id of owners) cache.invalidate(id);
  fixture.preparation.pause();
  fixture.store.prepareScenePaths = fixture.prepare;
  await completeDocumentPaths(fixture);
  expect(fixture.prepare.mock.calls.map(([ids]) => ids)).toEqual([[fixture.elements[0]!.id]]);
  fixture.preparation.release();
  fixture.store.release();
});

it("preserves required ID aliases when shared geometry fills the alias entry capacity", () => {
  const cache = new ScenePathCache(3, 4096);
  const first = indexedStroke(0);
  const points = [...first.points];
  Object.freeze(points);
  const element = { ...first, points };
  const shared = { ...element, id: indexedStroke(1).id };
  const parts = [{ d: "M0 0", paint: "fill" as const }];
  cache.completePreparation(element, parts);
  cache.retain(element.id, 1, parts);
  expect(cache.read(shared)).toBe(parts);
  cache.retain(shared.id, 1, parts);
  const required = indexedStroke(2).id;
  cache.retain(required, 1, [{ d: "M1 1", paint: "fill" }]);
  expect(cache.statistics().entries).toBe(2);
  expect(cache.retainSpeculative(indexedStroke(3).id, 1, parts)).toBe(false);
  expect([element.id, shared.id, required].every((id) => cache.has(id, 1))).toBe(true);
  expect(cache.statistics().evictions).toBe(0);
  cache.release();
});
