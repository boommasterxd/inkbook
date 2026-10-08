import { describe, expect, it, vi } from "vitest";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { DETACHED_ELEMENT_CACHE_MAX_BYTES } from "../../../../src/rendering/scene/constants";
import { DetachedSceneElementCache } from "../../../../src/rendering/scene/detached-element-cache";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { SceneMountPreparation } from "../../../../src/rendering/scene/scene-mount-preparation";
import { SceneDom } from "../../../../src/rendering/scene/scene-dom";
import { SceneVisibilityReconciler } from "../../../../src/rendering/scene/scene-visibility-reconciler";
import { SceneVisibilityState } from "../../../../src/rendering/scene/visibility-state";
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
import { MountSlice } from "../../../../src/rendering/scene/mount-slice";
import { arrow } from "../../domain/schema/fixtures";
import {
  createMountedElement,
  setMountedElementFade,
  setMountedElementMotion,
  updatePreviewTransform,
  type MountedSceneElement,
} from "../../../../src/rendering/scene/mounted-element";
import {
  asDocument,
  asElement,
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  fakeNode,
  fakeRectangleRecord,
} from "./fakes";

function fixture(id = "retained", ownerDocument = asDocument(new FakeDocument())) {
  const instrumentation = createInstrumentation();
  const record = fakeRectangleRecord(id, 0, 10);
  const entry = createMountedElement(
    ownerDocument,
    record,
    buildElementPathParts(record.element),
    instrumentation,
  );
  return { instrumentation, record, entry };
}

describe("connected scene ownership proofs", () => {
  it("transfers unchanged connected ownership without motion reads or order registrations", () => {
    const { entry, record } = fixture();
    const cache = new DetachedSceneElementCache();
    const store = new FakeSceneStore();
    store.records.set(record.id, record);
    const node = fakeNode(entry.paths[0]!.node);
    node.ownerDocument.createElementNS("", "g").append(node);
    cache.retainConnected(entry, store);
    const read = vi.spyOn(node, "getAttribute");
    const register = vi.spyOn(cache, "registerMounted");
    expect(cache.restoreConnected(record)).toBe(entry);
    expect(cache.statistics()).toMatchObject({ entries: 0, bytes: 0, hits: 1 });
    expect(cache.isReserved(record.id)).toBe(false);
    expect(cache.retainConnected(entry, store)).toBe(true);
    expect(register).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    cache.dispose();
  });

  it.each(["geometry", "paint", "band", "rank", "preview", "fade", "motion", "order"])(
    "keeps %s changes on the connected repair path",
    (change) => {
      const { entry, record, instrumentation } = fixture();
      const cache = new DetachedSceneElementCache();
      const store = new FakeSceneStore();
      const node = fakeNode(entry.paths[0]!.node);
      node.ownerDocument.createElementNS("", "g").append(node);
      cache.retainConnected(entry, store);
      const current = { ...record };
      if (change === "geometry") current.geometryVersion += 1;
      if (change === "paint") current.paintVersion += 1;
      if (change === "band") current.band = "highlight";
      if (change === "rank") current.rank += 1;
      if (change === "preview")
        updatePreviewTransform(entry, "translate(1 0)", 1, 1, instrumentation);
      if (change === "fade") setMountedElementFade(entry, 1);
      if (change === "motion") setMountedElementMotion(entry, 0.4);
      if (change === "order") cache.invalidateRanks();
      expect(cache.restoreConnected(current)).toBeUndefined();
      expect(cache.statistics().entries).toBe(1);
      cache.dispose();
    },
  );
});

describe("detached scene node ownership", () => {
  it("keeps connected revisits in their band without insertions or paint writes", () => {
    const { instrumentation, record, entry } = fixture();
    const cache = new DetachedSceneElementCache();
    const band = fakeNode(entry.paths[0]!.node).ownerDocument.createElementNS("", "g");
    band.append(fakeNode(entry.paths[0]!.node));
    const store = new FakeSceneStore();
    store.records.set(record.id, record);
    expect(cache.retainConnected(entry, store)).toBe(true);
    const insertion = vi.spyOn(band, "insertBefore");
    const before = instrumentation.attributeWrites;
    expect(cache.take(record, instrumentation)).toBe(entry);
    expect(fakeNode(entry.paths[0]!.node).parent).toBe(band);
    expect(insertion).not.toHaveBeenCalled();
    expect(instrumentation.attributeWrites).toBe(before);
    expect(cache.retainedRoots).toBe(1);
    cache.commitReservation(entry);
    expect(cache.retainedRoots).toBe(0);
    cache.dispose();
  });

  it("accounts queued roots until shared cleanup admission releases them", () => {
    const cache = new DetachedSceneElementCache(1024 * 1024);
    const store = new FakeSceneStore();
    const entries = Array.from({ length: 130 }, (_, rank) => {
      const result = fixture(`queued-${rank}`);
      const band = fakeNode(result.entry.paths[0]!.node).ownerDocument.createElementNS("", "g");
      band.append(fakeNode(result.entry.paths[0]!.node));
      store.records.set(result.record.id, result.record);
      cache.retainConnected(result.entry, store);
      return result.entry;
    });
    const bytes = cache.statistics().bytes;
    const remove = vi.spyOn(FakeNode.prototype, "remove");
    cache.setRetentionEnabled(false);
    expect(remove).not.toHaveBeenCalled();
    expect(cache.retainedRoots).toBe(130);
    expect(cache.statistics().bytes).toBe(bytes);
    expect(cache.flushEvictions(10, () => 0, { remainingRoots: 64, remainingRemovals: 3 })).toBe(
      true,
    );
    expect(remove).toHaveBeenCalledTimes(3);
    expect(cache.retainedRoots).toBe(127);
    remove.mockClear();
    expect(cache.flushEvictions(10, () => 10, { remainingRoots: 64 })).toBe(true);
    expect(remove).toHaveBeenCalledOnce();
    expect(cache.retainedRoots).toBe(126);
    remove.mockClear();
    expect(cache.flushEvictions(10, () => 0, { remainingRoots: 64 })).toBe(true);
    expect(remove).toHaveBeenCalledTimes(64);
    remove.mockClear();
    expect(cache.flushEvictions(10, () => 0, { remainingRoots: 64 })).toBe(false);
    expect(remove).toHaveBeenCalledTimes(62);
    expect(entries.every((entry) => fakeNode(entry.paths[0]!.node).parent === undefined)).toBe(
      true,
    );
    expect(cache.memoryUsage()).toBe(0);
    remove.mockRestore();
    cache.dispose();
  });

  it("refuses new ownership while a capacity eviction still owns connected roots", () => {
    const cache = new DetachedSceneElementCache(1_600);
    const store = new FakeSceneStore();
    const first = fixture("first-connected");
    const next = fixture("next-connected");
    for (const result of [first, next]) {
      const node = fakeNode(result.entry.paths[0]!.node);
      node.ownerDocument.createElementNS("", "g").append(node);
      store.records.set(result.record.id, result.record);
    }
    expect(cache.retainConnected(first.entry, store)).toBe(true);
    expect(cache.retainConnected(next.entry, store)).toBe(false);
    expect(cache.retainedRoots).toBe(1);
    expect(cache.isPendingRemoval(first.record.id)).toBe(true);
    cache.flushEvictions(10, () => 0, { remainingRoots: 64 });
    expect(cache.retainConnected(next.entry, store)).toBe(true);
    expect(cache.retainedRoots).toBe(1);
    cache.dispose();
    expect(cache.memoryUsage()).toBe(0);
  });
});

it("evicts only the byte space required by the next connected entry", () => {
  const entries = Array.from({ length: 4 }, (_, index) => fixture(`bytes-${index}`));
  const measure = new DetachedSceneElementCache();
  measure.retain(entries[0]!.entry);
  const bytes = measure.statistics().bytes;
  measure.release();
  const cache = new DetachedSceneElementCache(bytes * 3);
  const store = new FakeSceneStore();
  for (const { entry, record } of entries) {
    const node = fakeNode(entry.paths[0]!.node);
    node.ownerDocument.createElementNS("", "g").append(node);
    store.records.set(record.id, record);
  }
  for (const { entry } of entries.slice(0, 3))
    expect(cache.retainConnected(entry, store)).toBe(true);
  expect(cache.retainConnected(entries[3]!.entry, store)).toBe(false);
  expect(cache.statistics()).toMatchObject({ entries: 2, bytes: bytes * 3, evictions: 1 });
  expect(cache.retainedRoots).toBe(3);
  expect(cache.flushEvictions(10, () => 0, { remainingRoots: 64 })).toBe(false);
  expect(cache.retainConnected(entries[3]!.entry, store)).toBe(true);
  expect(cache.statistics()).toMatchObject({ entries: 3, bytes: bytes * 3, evictions: 1 });
  cache.dispose();
  expect(cache.memoryUsage()).toBe(0);
});

it.each(["retarget", "invalidation", "pressure"] as const)(
  "keeps staged connected ownership reserved through cache admission and %s cancellation",
  (reason) => {
    const dom = new SceneDom(asElement(new FakeNode(new FakeDocument(), "div")), "Canvas", {});
    const { entry, record, instrumentation } = fixture("reserved", dom.ownerDocument);
    const document = fakeNode(dom.svg).ownerDocument;
    fakeNode(dom.contentGroup).append(fakeNode(entry.paths[0]!.node));
    const store = new FakeSceneStore();
    store.records.set(record.id, record);
    const cache = new DetachedSceneElementCache(1_600);
    setMountedElementMotion(entry, 0.4);
    cache.retainConnected(entry, store);
    const bytes = cache.statistics().bytes;
    const visibility = new SceneVisibilityState(store, instrumentation);
    const result = visibility.query({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    const paths = new ScenePathCache();
    const mounted = new Map<string, MountedSceneElement>();
    const reconciler = new SceneVisibilityReconciler({
      dom,
      store,
      visibility,
      instrumentation,
      mounted,
      detachedCache: cache,
      pathCache: paths,
      orderDirty: { content: new Set(), highlight: new Set() },
    });
    let time = 0;
    const take = cache.take.bind(cache);
    vi.spyOn(cache, "take").mockImplementation((current, stats) => {
      const value = take(current, stats);
      time = 10;
      return value;
    });
    reconciler.replace(result.visibility);
    expect(
      reconciler.reconcile(10, () => time, new Map(), new Map(), { remainingRoots: 64 }).pending,
    ).toBe(true);
    expect(mounted.size).toBe(0);
    expect(cache.retainedRoots).toBe(1);
    expect(cache.statistics().bytes).toBe(bytes);
    const preparation = new SceneMountPreparation({
      ownerDocument: asDocument(document),
      store,
      instrumentation,
      detachedCache: cache,
      pathCache: paths,
    });
    const create = vi.spyOn(document, "createElementNS");
    expect(preparation.stage(record, new MountSlice(10, () => 0), undefined)).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    preparation.cancel();
    expect(cache.retain(fixture("competing").entry)).toBe(false);
    if (reason === "invalidation") cache.invalidate(record.id);
    if (reason === "pressure") cache.setRetentionEnabled(false);
    const remove = vi.spyOn(FakeNode.prototype, "remove");
    reconciler.cancel();
    expect(remove).not.toHaveBeenCalled();
    expect(cache.retainedRoots).toBe(1);
    expect(cache.statistics().bytes).toBe(bytes);
    if (reason === "retarget") expect(cache.take(record, instrumentation)).toBe(entry);
    else {
      expect(cache.isPendingRemoval(record.id)).toBe(true);
      expect(cache.take(record, instrumentation)).toBeUndefined();
      cache.flushEvictions(10, () => 0, { remainingRoots: 64, remainingRemovals: 1 });
      expect(remove).toHaveBeenCalledOnce();
      expect(cache.retainedRoots).toBe(0);
    }
    cache.dispose();
    expect(fakeNode(dom.contentGroup).nodes).toHaveLength(0);
    expect(cache.memoryUsage()).toBe(0);
    remove.mockRestore();
    paths.release();
  },
);

describe("detached committed node reuse", () => {
  it("bounds default detached ownership and immediately releases evicted entries", () => {
    const cache = new DetachedSceneElementCache();
    const document = asDocument(new FakeDocument());
    const first = fixture("capacity-0", document);
    cache.retain(first.entry);
    let latest = first;
    for (let index = 1; index < 1_000; index += 1) {
      latest = fixture(`capacity-${index}`, document);
      cache.retain(latest.entry);
      expect(cache.memoryUsage()).toBeLessThanOrEqual(DETACHED_ELEMENT_CACHE_MAX_BYTES);
    }
    expect(cache.statistics().evictions).toBeGreaterThan(0);
    expect(cache.retainedRoots).toBeLessThan(1_000);
    expect(cache.take(first.record, first.instrumentation)).toBeUndefined();
    expect(cache.successor(first.record)).toBeUndefined();
    expect(cache.take(latest.record, latest.instrumentation)).toBe(latest.entry);
    expect(fakeNode(latest.entry.paths[0]!.node).parent).toBeUndefined();
    cache.release();
    expect(cache.statistics()).toMatchObject({ entries: 0, bytes: 0 });
    expect(cache.retainedRoots).toBe(0);
    expect(cache.memoryUsage()).toBe(0);
    cache.dispose();
  });

  it("reuses the same nodes without geometry or paint writes and refreshes ordering", () => {
    const { instrumentation, record, entry } = fixture();
    const cache = new DetachedSceneElementCache();
    cache.retain(entry);
    const writes = instrumentation.attributeWrites;
    expect(cache.take({ ...record, rank: 30, band: "highlight" }, instrumentation)).toBe(entry);
    expect(entry.rank).toBe(30);
    expect(entry.band).toBe("highlight");
    expect(entry.committedOrderEpoch).toBe(0);
    expect(instrumentation.attributeWrites).toBe(writes);
    expect(cache.statistics()).toMatchObject({ entries: 0, hits: 1, bytes: 0 });
    expect(cache.take(record, instrumentation)).toBeUndefined();
  });

  it("updates changed paint and clears transient transforms, fade, and motion on reuse", () => {
    const { instrumentation, record, entry } = fixture();
    const cache = new DetachedSceneElementCache();
    updatePreviewTransform(entry, "translate(20 0)", 2, 2, instrumentation);
    setMountedElementFade(entry, 200);
    setMountedElementMotion(entry, 0.4);
    cache.retain(entry);
    if (record.element.kind !== "rectangle") throw new Error("Expected rectangle.");
    const painted = {
      ...record,
      paintVersion: 2,
      element: { ...record.element, style: { ...record.element.style, outlineOpacity: 0.5 } },
    };
    expect(cache.take(painted, instrumentation)).toBe(entry);
    const node = fakeNode(entry.paths[0]!.node);
    expect(node.attributes.get("stroke-opacity")).toBe("0.5");
    expect(node.attributes.has("data-inkbook-motion")).toBe(false);
    expect(node.attributes.has("transform")).toBe(false);
    expect(node.style.animation).toBe("");
    expect(entry.previewStrokeWidthScale).toBeNull();
    expect(entry.paintVersion).toBe(2);
  });

  it("rejects stale geometry and transient preview geometry", () => {
    const { instrumentation, record, entry } = fixture();
    const cache = new DetachedSceneElementCache();
    cache.retain(entry);
    expect(cache.take({ ...record, geometryVersion: 2 }, instrumentation)).toBeUndefined();
    entry.displayedPathParts = [...entry.pathParts];
    cache.retain(entry);
    expect(cache.statistics().entries).toBe(0);
  });

  it("enforces byte capacity and releases deletion, pressure, and lifecycle state", () => {
    const first = fixture("first");
    const second = fixture("second");
    const bounded = new DetachedSceneElementCache(1_600);
    bounded.retain(first.entry);
    bounded.retain(second.entry);
    expect(bounded.statistics()).toMatchObject({ entries: 1, evictions: 1 });
    expect(bounded.take(first.record, first.instrumentation)).toBeUndefined();
    bounded.invalidate(second.record.id);
    expect(bounded.memoryUsage()).toBe(0);
    const tooSmall = new DetachedSceneElementCache(1);
    tooSmall.retain(first.entry);
    expect(tooSmall.memoryUsage()).toBe(0);
    bounded.retain(first.entry);
    bounded.setRetentionEnabled(false);
    expect(bounded.memoryUsage()).toBe(0);
    bounded.retain(first.entry);
    expect(bounded.memoryUsage()).toBe(0);
    bounded.setRetentionEnabled(true);
    bounded.retain(first.entry);
    bounded.release();
    expect(bounded.memoryUsage()).toBe(0);
  });
});

it("blocks a fresh mount when taking the stale connected cache entry itself queues retirement", () => {
  const { entry, record, instrumentation } = fixture("stale-take");
  const document = fakeNode(entry.paths[0]!.node).ownerDocument;
  document.createElementNS("", "g").append(fakeNode(entry.paths[0]!.node));
  const store = new FakeSceneStore();
  store.records.set(record.id, record);
  const cache = new DetachedSceneElementCache();
  cache.retainConnected(entry, store);
  const current = { ...record, geometryVersion: 2 };
  store.records.set(record.id, current);
  const paths = new ScenePathCache();
  const preparation = new SceneMountPreparation({
    ownerDocument: asDocument(document),
    instrumentation,
    pathCache: paths,
    store,
    detachedCache: cache,
  });
  const create = vi.spyOn(document, "createElementNS");
  expect(preparation.stage(current, new MountSlice(10, () => 0), undefined)).toBeUndefined();
  expect(cache.isPendingRemoval(record.id)).toBe(true);
  expect(create).not.toHaveBeenCalled();
  cache.flushEvictions(10, () => 0, { remainingRoots: 64 });
  expect(preparation.stage(current, new MountSlice(10, () => 0), undefined)).toBeDefined();
  expect(create).toHaveBeenCalledOnce();
  cache.dispose();
  preparation.cancel();
  paths.release();
});

it("bounds multipart cached ownership and keeps partial retirement until all native roots leave", () => {
  const { instrumentation, record } = fixture();
  const element = arrow(500);
  const current = { ...record, id: element.id, element };
  const parts = buildElementPathParts(element);
  const document = new FakeDocument();
  const entry = createMountedElement(asDocument(document), current, parts, instrumentation);
  const band = document.createElementNS("", "g");
  band.append(...entry.paths.map((path) => fakeNode(path.node)));
  const store = new FakeSceneStore();
  store.records.set(current.id, current);
  const tooSmall = new DetachedSceneElementCache(1_600);
  expect(tooSmall.retainConnected(entry, store)).toBe(false);
  const cache = new DetachedSceneElementCache(1024 * 1024);
  expect(cache.retainConnected(entry, store)).toBe(true);
  expect(cache.retainedRoots).toBe(parts.length);
  cache.invalidate(entry.id);
  expect(cache.flushEvictions(10, () => 0, { remainingRoots: 64, remainingRemovals: 1 })).toBe(
    true,
  );
  expect(band.nodes).toHaveLength(parts.length - 1);
  expect(cache.retainedRoots).toBe(parts.length - 1);
  expect(cache.take(current, instrumentation)).toBeUndefined();
  expect(cache.isPendingRemoval(entry.id)).toBe(true);
  cache.flushEvictions(10, () => 0, { remainingRoots: 64 });
  expect(band.nodes).toHaveLength(0);
  expect(cache.memoryUsage()).toBe(0);
  cache.dispose();
});
