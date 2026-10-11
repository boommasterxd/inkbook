import { expect, it, vi } from "vitest";

import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { CanonicalElementPathPreparation } from "../../../../src/domain/geometry/canonical-element-path-preparation";
import { ViewportPreviewSelection } from "../../../../src/rendering/scene/preview-transform-selection";
import type { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { SCENE_PUBLICATION_ROOTS_PER_FRAME } from "../../../../src/rendering/scene/constants";
import type { SceneElementRecord } from "../../../../src/rendering/scene/types";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import {
  createSceneFixture,
  createSceneRecord,
  createViewportRectangleStore,
} from "../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import { expectReleasedPublicationScene } from "../../../fixtures/rendering/scene-publication";
import {
  FakeNode,
  FakeSceneStore,
  fakeNode,
  fakeRectangleRecord,
} from "../../../unit/rendering/scene/fakes";

const VIEWPORT = { height: 100, left: 0, top: 0, width: 100 };

function setNavigationPreview(
  renderer: SvgSceneRenderer,
  record: SceneElementRecord,
  kind: "immediate" | "progressive" | "transform",
  version: number,
): void {
  if (kind === "transform") renderer.setPreviewTransform([record.id], "translate(5 0)", version);
  else if (kind === "progressive")
    renderer.setProgressiveElementPreviews([record.id], () => record.element, version);
  else renderer.setElementPreviews([record.element], version);
}

it.each(["immediate", "progressive", "transform"] as const)(
  "rechecks an active %s preview across published cleanup targets and its return",
  (kind) => {
    const store = createViewportRectangleStore(300, () => 50);
    const protectedRecord = fakeRectangleRecord("protected", 300, 20, -301);
    const middle = fakeRectangleRecord("middle", 301, 20, 1_200);
    const final = fakeRectangleRecord("final", 302, 20, 2_200);
    for (const record of [protectedRecord, middle, final]) store.records.set(record.id, record);
    const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, VIEWPORT);
    scheduler.runAll();
    const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
    const protectedNode = content.nodes[content.nodes.length - 1]!;
    const removal = vi.spyOn(protectedNode, "remove");
    try {
      setNavigationPreview(renderer, protectedRecord, kind, 1);
      scheduler.runAll();
      renderer.setViewport({ ...VIEWPORT, top: 1_000 });
      scheduler.runNext();
      expect(renderer.mountedIds("content")).toEqual([middle.id]);
      expect(renderer.mountedCount).toBe(238);
      renderer.setViewport({ ...VIEWPORT, top: 2_000 });
      scheduler.runAll();
      expect(renderer.mountedIds("content")).toEqual([final.id]);
      expect(renderer.mountedCount).toBe(2);
      expect(protectedNode.parent).toBe(content);
      expect(removal).not.toHaveBeenCalled();
      renderer.setViewport(VIEWPORT);
      scheduler.runAll();
      expect(renderer.mountedIds("content")).toContain(protectedRecord.id);
      expect(renderer.mountedCount).toBe(301);
      expect(protectedNode.parent).toBe(content);
      expect(removal).not.toHaveBeenCalled();
      renderer.setViewport({ ...VIEWPORT, top: 2_000 });
      scheduler.runAll();
      setNavigationPreview(renderer, final, kind, 2);
      scheduler.runAll();
      expect(removal).toHaveBeenCalledOnce();
      expect(protectedNode.parent).toBeUndefined();
      expect(renderer.mountedIds("content")).toEqual([final.id]);
      expect(renderer.mountedCount).toBe(1);
      expect(content.nodes).toHaveLength(1);
    } finally {
      removal.mockRestore();
      renderer.destroy();
    }
    expectReleasedPublicationScene(renderer, scheduler);
  },
);

it("releases invalidated detached roots before fresh publication on an immediate return", () => {
  const store = new FakeSceneStore();
  const original = Array.from({ length: 130 }, (_, rank) =>
    fakeRectangleRecord(`stale-${rank}`, rank, 10 + rank * 25),
  );
  for (const record of original) store.records.set(record.id, record);
  const viewport = { ...VIEWPORT, width: 4_000 };
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  scheduler.runAll();
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  const oldPaths = content.nodes.map((node) => node.attributes.get("d")!);
  renderer.setViewport({ ...viewport, top: 10_000 });
  scheduler.runAll();
  expect(renderer.mountedCount).toBe(0);
  expect(content.nodes).toHaveLength(0);
  const replacements = original.map((record) => {
    if (record.element.kind !== "rectangle") throw new Error("Expected a rectangle.");
    const next = { ...record, geometryVersion: 2, element: { ...record.element, width: 21 } };
    store.records.set(record.id, next);
    return next;
  });
  renderer.applyDelta({ affected: replacements.map(({ id }) => ({ id, domains: ["geometry"] })) });
  renderer.setViewport(viewport);
  const newPaths = replacements.map((record) => buildElementPathParts(record.element)[0]!.d);
  const remove = vi.spyOn(FakeNode.prototype, "remove");
  try {
    let frames = 0;
    while (scheduler.pendingCount > 0) {
      expect(frames++).toBeLessThan(20);
      remove.mockClear();
      scheduler.runNext();
      expect(remove.mock.calls.length).toBeLessThanOrEqual(64);
      const painted = new Set(content.nodes.map((node) => node.attributes.get("d")));
      original.forEach((_record, index) => {
        expect(painted.has(oldPaths[index]) && painted.has(newPaths[index])).toBe(false);
      });
    }
    expect(content.nodes.map((node) => node.attributes.get("d"))).toEqual(newPaths);
    expect(renderer.mountedCount).toBe(130);
  } finally {
    remove.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

function createNavigationHarness() {
  const store = new FakeSceneStore();
  for (let index = 0; index < 1_201; index += 1) {
    const id = `rectangle-${index}`;
    store.records.set(id, fakeRectangleRecord(id, index, 10 + index / 1_000));
  }
  const { document, renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, VIEWPORT);
  const nodes = vi.spyOn(document, "createElementNS");
  return { nodes, renderer, scheduler, store };
}

it("retargets a pending viewport without recreating still-visible staged nodes", () => {
  const { nodes, renderer, scheduler, store } = createNavigationHarness();
  store.records.set("edge", fakeRectangleRecord("edge", 1_201, 190));
  scheduler.runNext();
  expect(renderer.mountedCount).toBe(SCENE_PUBLICATION_ROOTS_PER_FRAME);
  const prepared = nodes.mock.calls.length;
  expect(prepared).toBeGreaterThan(0);
  expect(prepared).toBeLessThan(store.records.size);

  renderer.setCamera({ x: -50, zoom: 1 });
  scheduler.runAll();

  expect(renderer.mountedCount).toBe(store.records.size);
  expect(nodes.mock.calls.filter(([, tag]) => tag === "path")).toHaveLength(store.records.size);
  expect(renderer.instrumentation().geometryBuilds).toBe(store.records.size);
  expect(renderer.mountedIds("content")[store.records.size - 1]).toBe("edge");
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
});

it("drops staged entries outside the new viewport and releases an interrupted mount", () => {
  const { nodes, renderer, scheduler } = createNavigationHarness();
  scheduler.runNext();
  expect(nodes.mock.calls.length).toBeGreaterThan(0);
  renderer.setViewport({ height: 100, left: 0, top: 10_000, width: 100 });
  scheduler.runAll();
  expect(renderer.mountedCount).toBe(0);
  expect(fakeNode(renderer.svg).nodes[1]!.nodes[4]!.nodes).toHaveLength(0);

  renderer.setViewport({ height: 100, left: 0, top: 0, width: 100 });
  scheduler.runNext();
  renderer.destroy();
  expect(renderer.mountedCount).toBe(0);
  expect(renderer.instrumentation().pathCacheEntries).toBe(0);
  expect(scheduler.pendingCount).toBe(0);
});

it("rejects stale staged geometry after a store delta during camera motion", () => {
  const { renderer, scheduler, store } = createNavigationHarness();
  scheduler.runNext();
  const id = "rectangle-1200";
  const before = store.records.get(id)!;
  const replacement = { ...fakeRectangleRecord(id, 1_200, 40), geometryVersion: 2 };
  store.records.set(id, replacement);
  renderer.applyDelta({
    affected: [{ id, domains: ["geometry"], before: before.element, after: replacement.element }],
  });
  renderer.setCamera({ x: -50, zoom: 1 });
  scheduler.runAll();

  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  expect(content.nodes[content.nodes.length - 1]?.attributes.get("d")).toBe(
    buildElementPathParts(replacement.element)[0]!.d,
  );
  expect(renderer.mountedCount).toBe(store.records.size);
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
});

it("cleans an obsolete delta exit while a cold entrant is suspended, then cancels it on resize", () => {
  const store = new FakeSceneStore();
  store.records.set("old", fakeRectangleRecord("old", 0, 20, -301));
  const stroke = {
    ...indexedStroke(100),
    points: Array.from({ length: 2_048 }, (_, index) => [20 + (index % 2), 411, 0.5]).flat(),
  };
  store.records.set(stroke.id, createSceneRecord(stroke, 1));
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, VIEWPORT);
  scheduler.runAll();
  expect(renderer.mountedIds("content")).toEqual(["old"]);
  const originalStep = Object.getOwnPropertyDescriptor(
    CanonicalElementPathPreparation.prototype,
    "step",
  )!.value as CanonicalElementPathPreparation["step"];
  const step = vi
    .spyOn(CanonicalElementPathPreparation.prototype, "step")
    .mockImplementation(function (this: CanonicalElementPathPreparation, deadline, now) {
      const complete = originalStep.call(this, deadline, now);
      scheduler.time += 8;
      return complete;
    });
  renderer.setViewport({ height: 100, left: 0, top: 120, width: 100 });
  let remaining = 100;
  while (renderer.mountedCount > 0 || step.mock.calls.length === 0) {
    expect(remaining--).toBeGreaterThan(0);
    scheduler.runNext();
  }
  expect(step.mock.results.every((result) => result.value === false)).toBe(true);
  step.mockRestore();
  expect(renderer.mountedCount).toBe(0);
  renderer.setViewport({ height: 100, left: 0, top: 0, width: 120 });
  scheduler.runAll(30);
  expect(renderer.mountedIds("content")).toEqual(["old"]);
  expect(renderer.instrumentation().domExits).toBe(1);
  expect(renderer.instrumentation().domEntrants).toBe(2);
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
});

it("releases an offscreen progressive preview without waiting for another visibility delta", () => {
  const store = new FakeSceneStore();
  const record = fakeRectangleRecord("preview", 0, 20, -301);
  store.records.set(record.id, record);
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, VIEWPORT);
  scheduler.runAll();
  renderer.setProgressiveElementPreviews([record.id], () => record.element, 1);
  scheduler.runAll();
  renderer.setViewport({ height: 100, left: 0, top: 120, width: 100 });
  scheduler.runAll();
  expect(renderer.mountedCount).toBe(1);
  renderer.clearProgressiveElementPreviews();
  scheduler.runAll();
  expect(renderer.mountedCount).toBe(0);
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
});

it("resumes a wide unchanged edge query before reporting a scene commit", () => {
  const store = createViewportRectangleStore(300, () => -190);
  const onSceneCommitted = vi.fn();
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, VIEWPORT, {
    onSceneCommitted,
  });
  scheduler.runAll(20);
  expect(onSceneCommitted).toHaveBeenCalledOnce();
  const get = vi.spyOn(store, "get");
  const query = vi.spyOn(store, "query");
  const now = vi.spyOn(scheduler, "now").mockImplementation(() => scheduler.time++);
  try {
    renderer.setViewport({ ...VIEWPORT, top: 120 });
    renderer.setPage(NAVIGATION_PAGE, 2_000);
    scheduler.runNext();
    const firstFrameReads = get.mock.calls.length;
    expect(firstFrameReads).toBeGreaterThan(0);
    expect(firstFrameReads).toBeLessThan(store.records.size);
    expect(query).toHaveBeenCalled();
    expect(scheduler.pendingCount).toBeGreaterThan(0);
    expect(renderer.mountedCount).toBe(store.records.size);
    expect(onSceneCommitted).toHaveBeenCalledOnce();
    scheduler.runNext();
    expect(get.mock.calls.length).toBeGreaterThan(firstFrameReads);
    expect(onSceneCommitted).toHaveBeenCalledOnce();
    now.mockRestore();
    scheduler.runAll(20);
    expect(renderer.mountedCount).toBe(store.records.size);
    expect(onSceneCommitted).toHaveBeenCalledTimes(2);
  } finally {
    now.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

it("retargets the camera and invalidates the store while an edge query is pending", () => {
  const store = createViewportRectangleStore(300, () => -190);
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, VIEWPORT);
  scheduler.runAll(20);
  const now = vi.spyOn(scheduler, "now").mockImplementation(() => scheduler.time++);
  try {
    renderer.setViewport({ ...VIEWPORT, top: 120 });
    scheduler.runNext();
    expect(scheduler.pendingCount).toBeGreaterThan(0);
    const next = fakeRectangleRecord("retargeted", 300, 1_020, 50);
    store.records.set(next.id, next);
    renderer.setCamera({ x: -1_000, zoom: 1 });
    renderer.applyDelta({
      affected: [
        {
          id: next.id,
          before: null,
          after: next.element,
          domains: ["geometry", "paint", "order", "visibility"],
        },
      ],
    });
    now.mockRestore();
    scheduler.runAll(30);
    expect(renderer.mountedIds("content")).toEqual([next.id]);
  } finally {
    now.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

it.each(["immediate", "progressive", "transform"] as const)(
  "releases an offscreen deferred exit when the %s preview replaces its ID",
  (kind) => {
    const store = new FakeSceneStore();
    const old = fakeRectangleRecord("preview", 0, 20, -301);
    const next = fakeRectangleRecord("next", 1, 20, 10_000);
    store.records.set(old.id, old);
    const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, VIEWPORT);
    try {
      scheduler.runAll();
      expect(renderer.mountedIds("content")).toEqual([old.id]);
      setNavigationPreview(renderer, old, kind, 1);
      scheduler.runAll();
      expect(renderer.mountedIds("content")).toEqual([old.id]);
      renderer.setViewport({ ...VIEWPORT, top: 120 });
      scheduler.runAll();
      expect(renderer.mountedCount).toBe(1);
      expect(fakeNode(renderer.svg).nodes[1]!.nodes[4]!.nodes).toHaveLength(1);
      store.records.set(next.id, next);
      setNavigationPreview(renderer, next, kind, 2);
      scheduler.runAll();
      expect(renderer.mountedCount).toBe(0);
      expect(fakeNode(renderer.svg).nodes[1]!.nodes[4]!.nodes).toHaveLength(0);
      expect(renderer.instrumentation().detachedCacheEntries).toBe(1);
    } finally {
      renderer.destroy();
    }
    expect(scheduler.pendingCount).toBe(0);
  },
);

it.each(["progressive", "transform"] as const)(
  "releases a deferred exit when %s preview bounds leave the viewport context",
  (kind) => {
    const store = new FakeSceneStore();
    const old = fakeRectangleRecord("old-preview", 0, 20, 50);
    store.records.set(old.id, old);
    const ids = [old.id];
    for (let rank = 1; rank <= 256; rank += 1) {
      const record = fakeRectangleRecord(`candidate-${rank}`, rank, 190, 800);
      store.records.set(record.id, record);
      ids.push(record.id);
    }
    const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, VIEWPORT);
    const selection = vi.spyOn(ViewportPreviewSelection.prototype, "select");
    const selectedIds = (): readonly string[] | undefined =>
      selection.mock.results[selection.mock.results.length - 1]?.value as
        readonly string[] | undefined;
    try {
      scheduler.runAll();
      if (kind === "progressive") {
        renderer.setProgressiveElementPreviews(ids, (id) => store.get(id)?.element, 1, {
          transform: "translate(0 0)",
          inverse: "translate(0 0)",
          transformBounds: (bounds) => bounds,
        });
      } else {
        renderer.setPreviewTransform(ids, "translate(5 0)", 1, "scale", (bounds) => ({
          ...bounds,
          minX: bounds.minX + 5,
          maxX: bounds.maxX + 5,
        }));
      }
      scheduler.runAll();
      expect(renderer.mountedIds("content")).toEqual([old.id]);
      expect(selectedIds()).toEqual([old.id]);
      const oldNode = fakeNode(renderer.svg).nodes[1]!.nodes[4]!.nodes[0]!;
      if (kind === "transform") expect(oldNode.attributes.get("transform")).toBe("translate(5 0)");
      renderer.setViewport({ ...VIEWPORT, top: 500 });
      scheduler.runAll();
      expect(selectedIds()).toEqual([]);
      expect(renderer.mountedIds("content")).toEqual([]);
      expect(renderer.mountedCount).toBe(0);
      expect(oldNode.parent).toBeUndefined();
      renderer.setViewport({ ...VIEWPORT, top: 650 });
      if (kind === "transform") renderer.setCamera({ x: -300, zoom: 1 });
      scheduler.runAll(20);
      expect(selectedIds()).toEqual([]);
      expect(selectedIds()).not.toContain(old.id);
      expect({
        domExits: renderer.instrumentation().domExits,
        mountedCount: renderer.mountedCount,
        pendingFrames: scheduler.pendingCount,
      }).toEqual({
        domExits: 1,
        mountedCount: 0,
        pendingFrames: 0,
      });
      expect(oldNode.parent).toBeUndefined();
      expect(oldNode.attributes.has("transform")).toBe(false);
    } finally {
      selection.mockRestore();
      renderer.destroy();
    }
    expect(scheduler.pendingCount).toBe(0);
  },
);

it.each([true, false])(
  "rechecks retained exit candidates against the final viewport (returning=%s)",
  (returning) => {
    const { renderer, scheduler, store } = createNavigationHarness();
    store.records.set("edge", fakeRectangleRecord("edge", 1_201, 190));
    scheduler.runAll();
    const mounted = renderer.mountedCount;
    const now = vi.spyOn(scheduler, "now").mockImplementation(() => scheduler.time++);
    renderer.setCamera({ x: returning ? -1_000 : -50, zoom: 1 });
    scheduler.runNext();
    expect(renderer.mountedCount).toBeGreaterThanOrEqual(mounted - 1);
    expect(renderer.mountedCount).toBeLessThanOrEqual(mounted + 1);
    expect(renderer.instrumentation().domExits).toBeLessThanOrEqual(1);
    renderer.setCamera({ x: returning ? 0 : -1_000, zoom: 1 });
    now.mockRestore();
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(returning ? mounted : 0);
    renderer.destroy();
    expect(scheduler.pendingCount).toBe(0);
  },
);
