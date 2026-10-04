import { describe, expect, it } from "vitest";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { DetachedSceneElementCache } from "../../../../src/rendering/scene/detached-element-cache";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import {
  createMountedElement,
  setMountedElementFade,
  setMountedElementMotion,
  updatePreviewTransform,
} from "../../../../src/rendering/scene/mounted-element";
import { asDocument, FakeDocument, fakeNode, fakeRectangleRecord } from "./fakes";

function fixture(id = "retained") {
  const instrumentation = createInstrumentation();
  const record = fakeRectangleRecord(id, 0, 10);
  const entry = createMountedElement(
    asDocument(new FakeDocument()),
    record,
    buildElementPathParts(record.element),
    instrumentation,
  );
  return { instrumentation, record, entry };
}

describe("detached scene node ownership", () => {
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

  it("enforces entry and byte capacities and releases deletion, pressure, and lifecycle state", () => {
    const first = fixture("first");
    const second = fixture("second");
    const bounded = new DetachedSceneElementCache(1, 1024 * 1024);
    bounded.retain(first.entry);
    bounded.retain(second.entry);
    expect(bounded.statistics()).toMatchObject({ entries: 1, evictions: 1 });
    expect(bounded.take(first.record, first.instrumentation)).toBeUndefined();
    bounded.invalidate(second.record.id);
    expect(bounded.memoryUsage()).toBe(0);
    const tooSmall = new DetachedSceneElementCache(10, 1);
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
