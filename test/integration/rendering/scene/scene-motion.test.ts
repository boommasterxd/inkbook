import { describe, expect, it } from "vitest";

import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import type { BoxShapeElementV1, PageV1 } from "../../../../src/domain/schema/public";
import { SvgSceneRenderer } from "../../../../src/rendering/scene";
import {
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  FakeScheduler,
  asElement,
  fakeNode,
  fakeRectangleRecord,
} from "../../../unit/rendering/scene/fakes";

const PAGE: PageV1 = {
  activeBufferLines: 3,
  background: { type: "none" },
  innerWidth: 2000,
  lockedBufferLines: 1,
  margin: 24.3,
};

describe("preview visibility leases", () => {
  it("keeps a transformed preview mounted while its committed bounds are culled", () => {
    const { renderer, scheduler, store } = setup();
    store.records.clear();
    store.records.set("moving", fakeRectangleRecord("moving", 0, 0, 1_000));
    renderer.setViewport({ height: 100, left: 0, top: 1_000, width: 100 });
    scheduler.runAll();

    renderer.setPreviewTransform(["moving"], "translate(0 -1000)", 1);
    renderer.setViewport({ height: 100, left: 0, top: 0, width: 100 });
    scheduler.runAll();

    expect(renderer.mountedCount).toBe(1);
    expect(contentPath(renderer, 0).attributes.get("transform")).toBe("translate(0 -1000)");
    renderer.clearPreviewTransforms();
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(0);
  });

  it("keeps an exact connected-element preview mounted until it is cleared", () => {
    const { renderer, scheduler, store } = setup();
    const record = fakeRectangleRecord("exact", 0, 0, 1_000);
    store.records.clear();
    store.records.set(record.id, record);
    renderer.setViewport({ height: 100, left: 0, top: 1_000, width: 100 });
    scheduler.runAll();
    const element = record.element as BoxShapeElementV1;

    renderer.setElementPreviews([{ ...element, pivot: { x: element.pivot.x, y: 10 }, y: 0 }], 1);
    renderer.setViewport({ height: 100, left: 0, top: 0, width: 100 });
    scheduler.runAll();

    expect(renderer.mountedCount).toBe(1);
    renderer.clearElementPreviews();
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(0);
  });
});

describe("imperative canvas motion", () => {
  it("keeps a successfully erased element hidden until the scene commit removes it", () => {
    const { renderer, scheduler, store } = setup();
    scheduler.runAll();
    const path = contentPath(renderer, 0);
    const before = store.records.get("a")?.element as BoxShapeElementV1;
    renderer.setElementFade(["a"], 160);
    expect(path.style.opacity).toBe("0");
    expect(path.style.filter).toBe("blur(50px)");

    store.records.delete("a");
    renderer.applyDelta({
      affected: [{ after: null, before, domains: ["visibility"], id: "a" }],
    });
    renderer.clearElementFade(["a"]);

    expect(path.style.opacity).toBe("0");
    expect(renderer.instrumentation().motionTombstones).toBe(0);
    scheduler.runNext();
    expect(renderer.mountedCount).toBe(0);
  });

  it("retains bounded non-interactive removal tombstones and releases every byte", () => {
    const { renderer, scheduler, store } = setup();
    scheduler.runAll();
    removeRecord(renderer, store, "a");

    expect(renderer.instrumentation()).toMatchObject({
      motionCacheEntries: 1,
      motionRemovalInvalidations: 1,
      motionTombstones: 1,
    });
    const tombstone = motionGroup(renderer).nodes[0]!;
    expect(tombstone.attributes.get("aria-hidden")).toBe("true");
    expect(tombstone.attributes.get("pointer-events")).toBe("none");

    scheduler.runNext();
    expect(renderer.mountedCount).toBe(0);
    scheduler.time = 120;
    scheduler.runAll();
    expect(motionGroup(renderer).nodes).toHaveLength(0);
    expect(renderer.instrumentation()).toMatchObject({
      motionCacheBytes: 0,
      motionCacheEntries: 0,
    });

    renderer.destroy();
    expect(renderer.instrumentation()).toMatchObject({
      motionCacheBytes: 0,
      motionCacheEntries: 0,
      pathCacheBytes: 0,
      pathCacheEntries: 0,
    });
  });

  it("invalidates removed path-cache entries synchronously with the model delta", () => {
    const { renderer, scheduler, store } = setup();
    scheduler.runAll();
    renderer.setViewport({ height: 100, left: 0, top: 1_000, width: 100 });
    scheduler.runAll();
    expect(renderer.instrumentation().pathCacheEntries).toBe(1);
    removeRecord(renderer, store, "a");

    expect(renderer.instrumentation()).toMatchObject({
      motionRemovalInvalidations: 1,
      pathCacheEntries: 0,
    });
  });
});

describe("element motion", () => {
  it("animates entrances and exact geometry, while preview handoffs stay immediate", () => {
    const { renderer, scheduler, store } = setup();
    scheduler.runAll();
    const added = fakeRectangleRecord("paste", 1, 40);
    addRecord(renderer, store, added);
    scheduler.runNext();
    const pastePath = contentPath(renderer, 1);
    expect(pastePath.style.opacity).toBe("0");
    expect(pastePath.style.transform).toBe("scale(0.96)");
    scheduler.time = 60;
    scheduler.runNext();
    expect(Number(pastePath.style.opacity)).toBeGreaterThan(0.5);
    scheduler.time = 120;
    scheduler.runAll();
    expect(pastePath.style.opacity).toBeUndefined();

    const previous = store.records.get("a")!;
    const before = previous.element as BoxShapeElementV1;
    const after = { ...before, width: 60 };
    replaceRecord(renderer, store, previous, after, 2);
    scheduler.runNext();
    expect(contentPath(renderer, 0).attributes.get("d")).toBe(buildElementPathParts(before)[0]!.d);
    scheduler.time = 180;
    scheduler.runNext();
    const intermediate = contentPath(renderer, 0).attributes.get("d");
    expect(intermediate).not.toBe(buildElementPathParts(before)[0]!.d);
    expect(intermediate).not.toBe(buildElementPathParts(after)[0]!.d);
    const retargeted = { ...after, width: 80 };
    store.records.set("a", { ...previous, element: retargeted, geometryVersion: 3 });
    renderer.applyDelta({
      affected: [{ after: retargeted, before: after, domains: ["geometry"], id: "a" }],
    });
    expect(contentPath(renderer, 0).attributes.get("d")).toBe(intermediate);
    scheduler.time = 300;
    scheduler.runAll();
    expect(contentPath(renderer, 0).attributes.get("d")).toBe(
      buildElementPathParts(retargeted)[0]!.d,
    );

    const final = { ...retargeted, width: 100 };
    renderer.suppressMotionForNextDelta(["a"]);
    store.records.set("a", { ...previous, element: final, geometryVersion: 4 });
    renderer.applyDelta({
      affected: [{ after: final, before: retargeted, domains: ["geometry"], id: "a" }],
    });
    scheduler.runAll();
    expect(contentPath(renderer, 0).attributes.get("d")).toBe(buildElementPathParts(final)[0]!.d);
    expect(renderer.instrumentation().motionGeometryTransitions).toBe(2);
  });
});

describe("preview commit handoff", () => {
  it("holds an exact transform preview through its matching commit delta", () => {
    const { renderer, scheduler, store } = setup();
    scheduler.runAll();
    const path = contentPath(renderer, 0);
    const previous = store.records.get("a")!;
    const before = previous.element as BoxShapeElementV1;

    renderer.setPreviewTransform(["a"], "translate(25 40)", 1);
    scheduler.runAll();
    expect(path.attributes.get("transform")).toBe("translate(25 40)");

    const handoff = renderer.beginPreviewCommit();
    renderer.clearPreviewTransforms();
    scheduler.runAll();
    expect(path.attributes.get("transform")).toBe("translate(25 40)");

    expect(handoff.arm(["a"])).toBe(true);
    const after = {
      ...before,
      pivot: { x: before.pivot.x + 25, y: before.pivot.y + 40 },
      x: before.x + 25,
      y: before.y + 40,
    };
    store.records.set("a", { ...previous, element: after, geometryVersion: 2 });
    renderer.applyDelta({
      affected: [{ after, before, domains: ["geometry"], id: "a" }],
    });
    renderer.clearPreviewTransforms();
    expect(path.attributes.get("transform")).toBe("translate(25 40)");

    scheduler.runAll();
    expect(path.attributes.has("transform")).toBe(false);
    expect(path.attributes.get("d")).toBe(buildElementPathParts(after)[0]!.d);
    expect(renderer.instrumentation().motionGeometryTransitions).toBe(0);

    const later = { ...after, width: after.width + 10 };
    store.records.set("a", { ...previous, element: later, geometryVersion: 3 });
    renderer.applyDelta({
      affected: [{ after: later, before: after, domains: ["geometry"], id: "a" }],
    });
    scheduler.runNext();
    expect(renderer.instrumentation().motionGeometryTransitions).toBe(1);
  });

  it("clears cancelled handoffs and never creates geometry motion for culled elements", () => {
    const { renderer, scheduler, store } = setup();
    const offscreen = fakeRectangleRecord("offscreen", 1, 10, 1_000);
    store.records.set(offscreen.id, offscreen);
    scheduler.runAll();
    renderer.setPreviewTransform(["a", offscreen.id], "translate(5 0)", 1);
    scheduler.runAll();

    const cancelled = renderer.beginPreviewCommit();
    renderer.clearPreviewTransforms();
    cancelled.cancel();
    scheduler.runAll();
    expect(contentPath(renderer, 0).attributes.has("transform")).toBe(false);

    const before = offscreen.element as BoxShapeElementV1;
    const after = { ...before, width: before.width + 10 };
    store.records.set(offscreen.id, { ...offscreen, element: after, geometryVersion: 2 });
    renderer.applyDelta({
      affected: [{ after, before, domains: ["geometry"], id: offscreen.id }],
    });
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(1);
    expect(renderer.instrumentation().motionGeometryTransitions).toBe(0);
    expect(scheduler.pendingCount).toBe(0);
  });
});

describe("connected preview commit handoff", () => {
  it("holds exact element previews until a pending handoff is cancelled", () => {
    const { renderer, scheduler, store } = setup();
    scheduler.runAll();
    const path = contentPath(renderer, 0);
    const element = store.records.get("a")!.element as BoxShapeElementV1;
    const preview = { ...element, width: element.width + 40 };
    renderer.setElementPreviews([preview], 1);
    scheduler.runNext();
    const previewPath = path.attributes.get("d");
    const handoff = renderer.beginPreviewCommit();
    renderer.clearElementPreviews();
    expect(path.attributes.get("d")).toBe(previewPath);

    handoff.cancel();
    scheduler.runAll();
    expect(path.attributes.get("d")).toBe(buildElementPathParts(element)[0]!.d);
  });
});

describe("canvas crossfades and overlays", () => {
  it("crossfades paint and order while replacing backgrounds atomically", () => {
    const { renderer, scheduler, store } = setup();
    scheduler.runAll();
    const previous = store.records.get("a")!;
    const before = previous.element as BoxShapeElementV1;
    const painted = {
      ...before,
      style: { ...before.style, outlineOpacity: 0.25 },
    };
    store.records.set("a", { ...previous, element: painted, paintVersion: 2 });
    renderer.applyDelta({
      affected: [{ after: painted, before, domains: ["paint"], id: "a" }],
    });
    scheduler.runNext();
    expect(motionGroup(renderer).nodes).toHaveLength(1);
    expect(contentPath(renderer, 0).style.opacity).toBe("0");
    scheduler.time = 60;
    scheduler.runNext();
    expect(Number(contentPath(renderer, 0).style.opacity)).toBeGreaterThan(0.5);
    scheduler.time = 120;
    scheduler.runAll();

    store.records.set("a", { ...store.records.get("a")!, rank: 2 });
    renderer.applyDelta({
      affected: [{ after: painted, before: painted, domains: ["order"], id: "a" }],
    });
    scheduler.time = 240;
    scheduler.runAll();
    expect(renderer.instrumentation().motionCrossfades).toBe(2);

    renderer.setPage({ ...PAGE, background: { spacing: 25, type: "dots" } }, 500);
    scheduler.time = 300;
    scheduler.runNext();
    const camera = fakeNode(renderer.svg).nodes[1]!;
    const currentBackground = camera.nodes.find(({ attributes }) =>
      attributes.get("fill")?.startsWith("url(#inkbook-background-pattern-"),
    );
    expect(currentBackground?.style.opacity).toBeUndefined();
    expect(renderer.instrumentation().motionCrossfades).toBe(2);
    scheduler.time = 480;
    scheduler.runAll();
    expect(currentBackground?.style.opacity).toBeUndefined();
  });
});

describe("selection overlay motion", () => {
  it("animates handles while staging the latest snap feedback in the scene frame", () => {
    const { renderer, scheduler } = setup();
    scheduler.runAll();
    const overlayGroup = fakeNode(renderer.svg).nodes[2]!;
    const selection = overlayGroup.nodes[1]!;
    const handles = overlayGroup.nodes[2]!;
    const snap = overlayGroup.nodes[3]!;

    expect(selection.attributes.get("class")).toBe("inkbook-selection-overlay");
    expect(selection.attributes.get("data-selection-fill")).toBe("accent");

    renderer.setSelectionOverlayPath("M 0 0 L 10 10", "none", "M 2 2 a 5 5 0 1 0 10 0");
    renderer.setSnapMarkerPath("M 5 5 L 6 6");
    scheduler.runNext();
    expect(selection.attributes.get("data-selection-fill")).toBe("none");
    expect(selection.style.opacity).toBe("0");
    expect(selection.style.transform).toBe("scale(1)");
    expect(handles.attributes.get("class")).toBe("inkbook-selection-handles");
    expect(handles.style.opacity).toBe("0");
    expect(snap.style.opacity).toBe("1");

    renderer.interruptMotionForPointerDown();
    expect(selection.style.opacity).toBe("1");
    expect(handles.style.opacity).toBe("1");
    expect(snap.style.opacity).toBe("1");
    expect(renderer.instrumentation().motionInterruptions).toBe(1);

    renderer.setSelectionOverlayPath("M 0 0 L 10 0 L 10 10 Z", "accent");
    scheduler.runNext();
    expect(selection.attributes.get("data-selection-fill")).toBe("accent");

    renderer.setSelectionOverlayPath(null);
    renderer.setSnapMarkerPath(null);
    scheduler.runNext();
    expect(snap.attributes.get("d")).toBe("");
    renderer.interruptMotionForPointerDown();
    expect(selection.attributes.get("d")).toBe("");
    expect(handles.attributes.get("d")).toBe("");
    expect(snap.attributes.get("d")).toBe("");
  });

  it("keeps a moving selection overlay visible while replacing its non-empty path", () => {
    const { renderer, scheduler } = setup();
    scheduler.runAll();
    const selection = fakeNode(renderer.svg).nodes[2]!.nodes[1]!;

    renderer.setSelectionOverlayPath("M 0 0 L 10 0 L 10 10 Z");
    scheduler.runNext();
    scheduler.time = 60;
    scheduler.runNext();
    const visibleOpacity = selection.style.opacity;
    expect(Number(visibleOpacity)).toBeGreaterThan(0);

    renderer.setSelectionOverlayPath("M 20 30 L 30 30 L 30 40 Z");
    scheduler.runNext();
    expect(selection.attributes.get("d")).toBe("M 20 30 L 30 30 L 30 40 Z");
    expect(Number(selection.style.opacity)).toBeGreaterThanOrEqual(Number(visibleOpacity));

    renderer.setSelectionOverlayPath("M 40 50 L 50 50 L 50 60 Z");
    scheduler.runNext();
    expect(selection.attributes.get("d")).toBe("M 40 50 L 50 50 L 50 60 Z");
    expect(Number(selection.style.opacity)).toBeGreaterThanOrEqual(Number(visibleOpacity));
  });
});

describe("motion limits", () => {
  it("uses instant final states under reduced motion", () => {
    const { renderer, scheduler, store } = setup(true);
    scheduler.runAll();
    const added = fakeRectangleRecord("reduced", 1, 40);
    addRecord(renderer, store, added);
    renderer.setSelectionOverlayPath("M 0 0 L 1 1");
    renderer.setElementFade(["a"], 160);
    scheduler.runAll();

    expect(contentPath(renderer, 1).style.opacity).toBeUndefined();
    expect(contentPath(renderer, 0).style.transition).toContain("opacity 0ms");
    expect(contentPath(renderer, 0).style.filter).toBe("");
    expect(fakeNode(renderer.svg).nodes[2]!.nodes[1]!.style.opacity).toBe("1");
    expect(renderer.instrumentation()).toMatchObject({
      motionCacheEntries: 0,
      motionEntrances: 0,
    });
  });

  it("caps retained motion paths at 256", () => {
    const { renderer, scheduler, store } = setup();
    const records = Array.from({ length: 300 }, (_, index) =>
      fakeRectangleRecord(`removed-${String(index)}`, index + 1, 10),
    );
    for (const record of records) store.records.set(record.id, record);
    scheduler.runAll();
    for (const record of records) {
      store.records.delete(record.id);
      renderer.applyDelta({
        affected: [
          {
            after: null,
            before: record.element,
            domains: ["visibility"],
            id: record.id,
          },
        ],
      });
    }
    expect(renderer.instrumentation().motionCacheEntries).toBeLessThanOrEqual(256);
    expect(motionGroup(renderer).nodes.length).toBeLessThanOrEqual(256);
    renderer.destroy();
    expect(renderer.instrumentation()).toMatchObject({
      motionCacheBytes: 0,
      motionCacheEntries: 0,
    });
  });
});

function setup(reducedMotion = false): {
  renderer: SvgSceneRenderer;
  scheduler: FakeScheduler;
  store: FakeSceneStore;
} {
  const document = new FakeDocument();
  const scheduler = new FakeScheduler();
  const store = new FakeSceneStore();
  store.records.set("a", fakeRectangleRecord("a", 0, 10));
  const renderer = new SvgSceneRenderer({
    container: asElement(new FakeNode(document, "div")),
    layout: { readViewport: () => ({ height: 100, left: 0, top: 0, width: 100 }) },
    page: PAGE,
    reducedMotion,
    scheduler,
    store,
  });
  renderer.setPage(PAGE, 500);
  return { renderer, scheduler, store };
}

function contentPath(renderer: SvgSceneRenderer, index: number): FakeNode {
  return fakeNode(renderer.svg).nodes[1]!.nodes[4]!.nodes[index]!;
}

function motionGroup(renderer: SvgSceneRenderer): FakeNode {
  const camera = fakeNode(renderer.svg).nodes[1]!;
  return camera.nodes.find(({ attributes }) => attributes.get("class")?.includes("scene-motion"))!;
}

function addRecord(
  renderer: SvgSceneRenderer,
  store: FakeSceneStore,
  record: ReturnType<typeof fakeRectangleRecord>,
): void {
  store.records.set(record.id, record);
  renderer.applyDelta({
    affected: [{ after: record.element, before: null, domains: ["visibility"], id: record.id }],
  });
}

function removeRecord(renderer: SvgSceneRenderer, store: FakeSceneStore, id: string): void {
  const before = store.records.get(id)?.element as BoxShapeElementV1 | undefined;
  if (before === undefined) throw new Error(`Missing fake scene record: ${id}`);
  store.records.delete(id);
  renderer.applyDelta({
    affected: [{ after: null, before, domains: ["visibility"], id }],
  });
}

function replaceRecord(
  renderer: SvgSceneRenderer,
  store: FakeSceneStore,
  previous: ReturnType<typeof fakeRectangleRecord>,
  after: BoxShapeElementV1,
  geometryVersion: number,
): void {
  store.records.set(previous.id, { ...previous, element: after, geometryVersion });
  renderer.applyDelta({
    affected: [{ after, before: previous.element, domains: ["geometry"], id: previous.id }],
  });
}
