import { describe, expect, it, vi } from "vitest";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { DETACHED_ELEMENT_CACHE_MAX_BYTES } from "../../../../src/rendering/scene/constants";
import { DetachedSceneElementCache } from "../../../../src/rendering/scene/detached-element-cache";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { arrow } from "../../domain/schema/fixtures";
import { createTestStroke } from "../../../fixtures/persistence/worker-snapshot";
import {
  createMountedElement,
  setMountedElementFade,
  setMountedElementMotion,
  updatePreviewTransform,
} from "../../../../src/rendering/scene/mounted-element";
import { asDocument, FakeDocument, FakeSceneStore, fakeNode, fakeRectangleRecord } from "./fakes";

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

it("rejects connected roots without taking ownership or mutating mounted order", () => {
  const { entry, record } = fixture();
  const cache = new DetachedSceneElementCache();
  const store = new FakeSceneStore();
  store.records.set(record.id, record);
  const node = fakeNode(entry.paths[0]!.node);
  const band = node.ownerDocument.createElementNS("", "g");
  band.append(node);
  cache.registerMounted(entry, store);
  const remove = vi.spyOn(node, "remove");
  expect(cache.retain(entry)).toBe(false);
  expect(cache.statistics()).toMatchObject({ entries: 0, bytes: 0 });
  expect(cache.successor({ ...record, id: "before", rank: -1 })).toBe(entry);
  cache.setRetentionEnabled(false);
  expect(cache.successor({ ...record, id: "before", rank: -1 })).toBe(entry);
  cache.unregisterMounted(entry.id);
  expect(cache.successor({ ...record, id: "before", rank: -1 })).toBeUndefined();
  cache.dispose();
  expect(node.parent).toBe(band);
  expect(remove).not.toHaveBeenCalled();
  expect(cache.memoryUsage()).toBe(0);
  remove.mockRestore();
});

it("protects needed detached owners and evicts only the bytes required", () => {
  const entries = Array.from({ length: 4 }, (_, rank) => fixture(`bytes-${rank}`));
  const measure = new DetachedSceneElementCache();
  measure.retain(entries[0]!.entry);
  const bytes = measure.statistics().bytes;
  measure.dispose();
  const cache = new DetachedSceneElementCache(bytes * 3);
  for (const { entry } of entries.slice(0, 3)) expect(cache.retain(entry)).toBe(true);
  const needed = vi.fn((id: string) => id === entries[0]!.entry.id);
  expect(cache.retain(entries[3]!.entry, needed)).toBe(false);
  expect(needed).toHaveBeenCalledOnce();
  expect(cache.statistics()).toMatchObject({ entries: 3, bytes: bytes * 3, evictions: 0 });
  expect(cache.retain(entries[2]!.entry)).toBe(true);
  expect(cache.retain(entries[3]!.entry)).toBe(true);
  expect(cache.statistics()).toMatchObject({ entries: 3, bytes: bytes * 3, evictions: 1 });
  expect(cache.take(entries[0]!.record, entries[0]!.instrumentation)).toBeUndefined();
  cache.resetStatistics();
  expect(cache.statistics().evictions).toBe(0);
  cache.dispose();
});

it("requires every multipart root to detach before caching committed ownership", () => {
  const { instrumentation, record } = fixture();
  const element = arrow(500);
  const current = { ...record, id: element.id, element };
  const parts = buildElementPathParts(element);
  const document = new FakeDocument();
  const entry = createMountedElement(asDocument(document), current, parts, instrumentation);
  const band = document.createElementNS("", "g");
  // A detached first root does not prove the remaining roots are detached.
  band.append(...entry.paths.slice(1).map((path) => fakeNode(path.node)));
  const cache = new DetachedSceneElementCache();
  expect(parts.length).toBeGreaterThan(1);
  expect(cache.retain(entry)).toBe(false);
  for (const path of entry.paths) fakeNode(path.node).remove();
  expect(cache.retain(entry)).toBe(true);
  expect(cache.retainedRoots).toBe(parts.length);
  const tooSmall = new DetachedSceneElementCache(1_600);
  expect(tooSmall.retain(entry)).toBe(false);
  cache.invalidate(entry.id);
  expect(cache.retainedRoots).toBe(0);
  expect(cache.memoryUsage()).toBe(0);
  cache.dispose();
});

it("retains a detached pressure group with its owned children and preserves root identity", () => {
  const { instrumentation, record } = fixture();
  const element = createTestStroke();
  const current = { ...record, id: element.id, element };
  const document = new FakeDocument();
  const entry = createMountedElement(
    asDocument(document),
    current,
    buildElementPathParts(element),
    instrumentation,
  );
  const group = entry.group;
  if (group === null) throw new Error("Expected pressure group.");
  const cache = new DetachedSceneElementCache();
  expect(entry.paths.every(({ node }) => node.parentNode === group)).toBe(true);
  expect(cache.retain(entry)).toBe(true);
  const bytes = cache.statistics().bytes;
  expect(cache.retainedRoots).toBe(1);
  expect(cache.take(current, instrumentation)).toBe(entry);
  const band = document.createElementNS("", "g");
  band.append(fakeNode(group));
  expect(cache.retain(entry)).toBe(false);
  fakeNode(group).remove();
  expect(cache.retain(entry)).toBe(true);
  expect(cache.statistics().bytes).toBe(bytes);
  cache.dispose();
  expect(cache.retainedRoots).toBe(0);
  expect(cache.memoryUsage()).toBe(0);
});
