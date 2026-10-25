import { expect, it, vi } from "vitest";
import { SCENE_PUBLICATION_ROOTS_PER_FRAME } from "../../../../../src/rendering/scene/constants";
import { CanonicalElementPathPreparation } from "../../../../../src/domain/geometry/canonical-element-path-preparation";
import { DetachedSceneElementCache } from "../../../../../src/rendering/scene/content/detached-element-cache";
import { SceneDom } from "../../../../../src/rendering/scene/scene-dom";
import { ScenePathCache } from "../../../../../src/rendering/scene/content/path-cache";
import { SceneVisibilityReconciler } from "../../../../../src/rendering/scene/reconciliation/scene-visibility-reconciler";
import { SceneVisibilityState } from "../../../../../src/rendering/scene/visibility/visibility-state";
import {
  publishStableEntrantRun,
  publishVisibilityRun,
  RetainedDomOrder,
  type PendingMutationRun,
} from "../../../../../src/rendering/scene/reconciliation/visibility-publication";
import {
  createMountedElement,
  firstPath,
  type MountedSceneElement,
} from "../../../../../src/rendering/scene/content/mounted-element";
import { createInstrumentation } from "../../../../../src/rendering/scene/instrumentation";
import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import { createSceneFixture, createSceneRecord } from "../../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../../fixtures/rendering/pressure-navigation";
import {
  createPublicationScene,
  createDirectPublicationScene,
  createPreparedPublicationScene,
  observeSceneInsertions,
  settlePreparedPublication,
  waitForPreparedMounts,
} from "../../../../fixtures/rendering/scene-publication";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { arrow, stroke } from "../../../../unit/domain/schema/fixtures";
import {
  FakeSceneStore,
  FakeDocument,
  FakeNode,
  asElement,
  fakeNode,
  fakeRectangleRecord,
} from "../../../../unit/rendering/scene/fakes";

const INITIAL = { height: 100, left: 0, top: 0, width: 400 };
const TARGET = { ...INITIAL, top: 1_000 };

it.each(
  [publishStableEntrantRun, publishVisibilityRun].flatMap((publish) =>
    (["path", "pressure", "multipart", "siblings"] as const).map((kind) => ({ publish, kind })),
  ),
)(
  "$publish.name publishes $kind with bounded DOM work and preserves connected revisits",
  ({ publish, kind }) => {
    const { document, dom, instrumentation, store, before, entry, after, entrants, content } =
      createDirectPublicationScene(kind);
    if (kind === "path") entry.detachedPathCount = 1;
    const mounted = new Map<string, MountedSceneElement>();
    const run: PendingMutationRun = {
      band: "content",
      capacity: entrants.length,
      count: entrants.length,
      entrants: entrants.map(() => true),
      entries: entrants.slice().reverse(),
      preserveRetainedOrder: true,
      successor: after,
    };
    const fragment = vi.spyOn(document, "createDocumentFragment");
    const append = vi.spyOn(FakeNode.prototype, "append");
    const insert = vi.spyOn(content, "insertBefore");
    try {
      const roots = entrants.flatMap((item) =>
        item.group === null
          ? item.paths.map((path) => fakeNode(path.node))
          : [fakeNode(item.group)],
      );
      const ids = entrants.map((item) => item.id);
      const multipleRoots = kind === "multipart" || kind === "siblings";
      expect(entry.group).toBeNull();
      expect(roots).toHaveLength(multipleRoots ? 2 : 1);
      expect(publish(run, { dom, instrumentation, mounted, store }, 7, true)).toEqual(ids);
      expect(fragment.mock.calls.length).toBe(multipleRoots ? 1 : 0);
      expect(append.mock.calls.length).toBe(multipleRoots ? 2 : 0);
      expect(insert).toHaveBeenCalledOnce();
      expect(insert.mock.calls[0]![0]).toBe(
        multipleRoots ? fragment.mock.results[0]!.value : roots[0],
      );
      expect(insert.mock.calls[0]![1]).toBe(fakeNode(firstPath(after)));
      const expected = [fakeNode(firstPath(before)), ...roots, fakeNode(firstPath(after))];
      expect(content.nodes).toEqual(expected);
      expect(instrumentation.domRootsPublished).toBe(roots.length);
      expect(instrumentation.domFragmentRuns).toBe(1);
      expect(mounted.get(entry.id)).toBe(entry);
      expect(entry.committedOrderEpoch).toBe(7);
      expect(entry.detachedPathCount).toBe(0);
      fragment.mockClear();
      append.mockClear();
      insert.mockClear();
      expect(publish(run, { dom, instrumentation, mounted, store }, 8, true)).toEqual(ids);
      expect(fragment).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
      expect(instrumentation.domRootsPublished).toBe(roots.length);
      expect(content.nodes).toEqual(expected);
    } finally {
      fragment.mockRestore();
      append.mockRestore();
      insert.mockRestore();
      dom.release();
    }
  },
);

it("checks the original deadline between distinct retained rank gaps in a 10,000-element store", () => {
  const store = new FakeSceneStore();
  for (let rank = 0; rank < 10_000; rank += 1) {
    const record = fakeRectangleRecord(
      `rank-gap-${rank}`,
      rank,
      20 + rank / 4,
      rank >= 128 ? 10_000 : rank % 2 === 0 ? 20 : 1_030,
    );
    store.records.set(record.id, record);
  }
  const { renderer, scheduler, content } = createPublicationScene(store, INITIAL);
  const retained = [...content.nodes];
  expect(retained).toHaveLength(64);
  let publications = 0;
  let publishedRoots = 0;
  const insert = observeSceneInsertions(content, (roots) => {
    publications += 1;
    publishedRoots += roots;
    scheduler.time += 8;
  });
  try {
    renderer.setViewport({ ...INITIAL, height: 1_100 });
    let remaining = 100;
    while (scheduler.pendingCount > 0) {
      expect(remaining--).toBeGreaterThan(0);
      publications = 0;
      scheduler.runNext();
      expect(publications).toBeLessThanOrEqual(1);
      const physical = new Set(content.nodes);
      expect(retained.every((node) => physical.has(node))).toBe(true);
    }
    expect(publishedRoots).toBe(64);
    expect(content.nodes.map((node) => node.attributes.get("d"))).toEqual(
      [...store.records.values()]
        .slice(0, 128)
        .map((record) => buildElementPathParts(record.element)[0]!.d),
    );
  } finally {
    insert.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

it.each([0, 8])(
  "checks the shared deadline between complete SVG fragments with %i publication work",
  (cost) => {
    const store = new FakeSceneStore();
    const pressure = stroke(20_001);
    for (let rank = 0; rank < 10_000; rank += 1) {
      const record =
        rank === 3
          ? createSceneRecord(
              { ...arrow(20_000), start: { x: 20, y: 1_030 }, end: { x: 50, y: 1_030 } },
              rank,
            )
          : rank === 4
            ? createSceneRecord(
                {
                  ...pressure,
                  points: [20, 1_030, 0.5, 30, 1_030, 0.5],
                  style: { ...pressure.style, opacity: 0.25 },
                },
                rank,
              )
            : fakeRectangleRecord(
                `publication-${rank}`,
                rank,
                20,
                rank < SCENE_PUBLICATION_ROOTS_PER_FRAME ? 1_030 : 10_000,
              );
      store.records.set(record.id, record);
    }
    const { renderer, scheduler, content } = createPublicationScene(store, INITIAL);
    const arrowPaths = new Set(
      buildElementPathParts(store.get(arrow(20_000).id)!.element).map((part) => part.d),
    );
    let roots = 0;
    let steps = 0;
    const publicationCounts: number[] = [];
    const insert = observeSceneInsertions(content, (count) => {
      publicationCounts.push(count);
      roots += count;
      steps += 1;
      scheduler.time += cost;
    });
    const frames: number[] = [];
    try {
      renderer.setViewport(TARGET);
      let remaining = 100;
      while (scheduler.pendingCount > 0) {
        expect(remaining--).toBeGreaterThan(0);
        roots = 0;
        steps = 0;
        scheduler.runNext();
        frames.push(roots);
        expect(roots).toBeLessThanOrEqual(SCENE_PUBLICATION_ROOTS_PER_FRAME);
        if (cost > 0) expect(steps).toBeLessThanOrEqual(1);
        const arrowNodes = content.nodes.filter((node) =>
          arrowPaths.has(node.attributes.get("d") ?? ""),
        );
        expect([0, 2]).toContain(arrowNodes.length);
      }
      expect(frames.reduce((sum, count) => sum + count, 0)).toBe(
        SCENE_PUBLICATION_ROOTS_PER_FRAME + 1,
      );
      const pressureD = buildElementPathParts(store.get(pressure.id)!.element)[0]!.d;
      const pressureRoot = content.nodes.find((node) => node.attributes.get("d") === pressureD);
      expect(pressureRoot?.attributes.get("opacity")).toBe("0.25");
      expect(Math.max(...publicationCounts)).toBeLessThanOrEqual(17);
      expect(Math.max(...publicationCounts)).toBeGreaterThan(1);
      if (cost === 0) expect(frames).toContain(SCENE_PUBLICATION_ROOTS_PER_FRAME);
      expect(renderer.mountedIds("content")).toEqual(
        [...store.records.keys()].slice(0, SCENE_PUBLICATION_ROOTS_PER_FRAME),
      );
    } finally {
      insert.mockRestore();
      renderer.destroy();
    }
    expect(scheduler.pendingCount).toBe(0);
  },
);

it.each(["resume", "retarget", "destroy"])(
  "keeps a complete contour unpublished after preparation exhausts admission, then %s",
  (action) => {
    const store = new FakeSceneStore();
    const stroke = {
      ...indexedStroke(30_000),
      pivot: { x: 20, y: 1_030 },
      points: [20, 1_030, 0.5, 30, 1_030, 0.5],
    };
    store.records.set(stroke.id, createSceneRecord(stroke, 0));
    const { renderer, scheduler, insert, preparation } = createPreparedPublicationScene(
      store,
      INITIAL,
    );
    const { stage: step } = preparation;
    try {
      renderer.setViewport(TARGET);
      waitForPreparedMounts(scheduler, preparation);
      expect(insert).not.toHaveBeenCalled();
      expect(renderer.mountedCount).toBe(0);
      expect(scheduler.pendingCount).toBeGreaterThan(0);
      step.mockRestore();
      settlePreparedPublication(renderer, scheduler, action, INITIAL);
      expect(renderer.mountedCount).toBe(action === "resume" ? 1 : 0);
      expect(insert.mock.calls.length).toBe(action === "resume" ? 1 : 0);
    } finally {
      step.mockRestore();
      insert.mockRestore();
      renderer.destroy();
    }
    expect(scheduler.pendingCount).toBe(0);
  },
);

it("reads one physical sibling snapshot when a full fallback refreshes stale order epochs", () => {
  const store = new FakeSceneStore();
  const capacity = 10_000;
  for (let rank = 0; rank < capacity; rank += 1) {
    const record = fakeRectangleRecord(`snapshot-${rank}`, rank, 20, 10);
    store.records.set(record.id, record);
  }
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, INITIAL);
  const register = vi.spyOn(DetachedSceneElementCache.prototype, "registerMounted");
  scheduler.runAll(200);
  const entries = register.mock.calls.map(([entry]) => entry);
  register.mockRestore();
  const ids = [...store.records.keys()];
  for (const id of ids) {
    const record = store.get(id)!;
    store.records.set(id, { ...record, rank: capacity - record.rank });
  }
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  let snapshots = 0;
  let nodeReads = 0;
  const children = vi.spyOn(content, "childNodes", "get").mockImplementation(() => {
    snapshots += 1;
    return new Proxy(content.nodes, {
      get(target: FakeNode[], key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) nodeReads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
  });
  const insert = vi.spyOn(content, "insertBefore");
  try {
    renderer.applyDelta({ affected: ids.map((id) => ({ id, domains: ["order"] })) });
    scheduler.runAll(200);
    const orderWrites = insert.mock.calls.length;
    // Older proof generations require the real physical-order fallback without a reorder.
    for (const entry of entries) entry.committedOrderEpoch = -1;
    renderer.setProgressiveElementPreviews([ids[0]!], (id) => store.get(id)?.element, 1);
    renderer.clearProgressiveElementPreviews();
    scheduler.runAll(200);
    expect(snapshots).toBe(1);
    expect(nodeReads).toBe(capacity);
    expect(insert.mock.calls.length).toBe(orderWrites);
    expect(renderer.mountedIds("content")).toEqual([...ids].reverse());
  } finally {
    children.mockRestore();
    insert.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

it("shares the original deadline between live insertion and stale exit removal", () => {
  const store = new FakeSceneStore();
  const exiting = fakeRectangleRecord("stale-exit", 0, 20, 10);
  store.records.set(exiting.id, exiting);
  for (let rank = 1; rank <= 64; rank += 1) {
    const record = fakeRectangleRecord(`entrant-${rank}`, rank, 20, 1_030);
    store.records.set(record.id, record);
  }
  const { renderer, scheduler, content } = createPublicationScene(store, INITIAL);
  const oldNode = content.nodes[0]!;
  // A stale geometry version cannot use connected retention when it exits.
  store.records.set(exiting.id, { ...exiting, geometryVersion: 2 });
  let steps = 0;
  const originalInsert = content.insertBefore.bind(content);
  const originalRemove = oldNode.remove.bind(oldNode);
  const insert = vi.spyOn(content, "insertBefore").mockImplementation((node, successor) => {
    steps += 1;
    const result = originalInsert(node, successor);
    scheduler.time += 8;
    return result;
  });
  const remove = vi.spyOn(oldNode, "remove").mockImplementation(() => {
    steps += 1;
    originalRemove();
    scheduler.time += 8;
  });
  try {
    renderer.setViewport(TARGET);
    let remaining = 100;
    while (scheduler.pendingCount > 0) {
      expect(remaining--).toBeGreaterThan(0);
      steps = 0;
      scheduler.runNext();
      expect(steps).toBeLessThanOrEqual(1);
    }
    expect(remove).toHaveBeenCalledOnce();
    expect(renderer.mountedCount).toBe(64);
    expect(oldNode.parent).toBeUndefined();
  } finally {
    insert.mockRestore();
    remove.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

it.each([
  { pressure: false, late: false, roots: 64 },
  { pressure: true, late: false, roots: 64 },
  { pressure: true, late: true, roots: 64 },
  { pressure: true, late: true, roots: 0 },
])(
  "records queued retained publication before pressure/exit work: %j",
  ({ pressure, late, roots }) => {
    const fixture = retainedReorderFixture(pressure);
    const { reconciler, dom, instrumentation, paths, visibility } = fixture;
    let time = 0;
    const originalObserve = Object.getOwnPropertyDescriptor(RetainedDomOrder.prototype, "observe")!
      .value as RetainedDomOrder["observe"];
    const observe = vi.spyOn(RetainedDomOrder.prototype, "observe").mockImplementation(function (
      this: RetainedDomOrder,
      entry,
      band,
    ) {
      const preserved = originalObserve.call(this, entry, band);
      if (!preserved) time += 8;
      return preserved;
    });
    const content = fakeNode(dom.contentGroup);
    const originalInsert = content.insertBefore.bind(content);
    const insert = vi.spyOn(content, "insertBefore").mockImplementation((node, successor) => {
      const result = originalInsert(node, successor);
      time += 8;
      return result;
    });
    const preparation = vi.spyOn(CanonicalElementPathPreparation.prototype, "step");
    const remove = vi.spyOn(fixture.exit, "remove");
    try {
      const first = reconciler.reconcile(8, () => time, new Map(), new Map(), {
        remainingRoots: 64,
      });
      expect(first.pending).toBe(true);
      expect(first.newlyMountedIds).toHaveLength(0);
      expect(insert).not.toHaveBeenCalled();
      instrumentation.visibilityReconcileVisits = 0;
      const next = reconciler.reconcile(late ? time : 16, () => time, new Map(), new Map(), {
        allowLatePreparedUnit: late,
        remainingRoots: roots,
      });
      expect(next.pending).toBe(true);
      expect(next.newlyMountedIds).toHaveLength(0);
      expect(insert.mock.calls.length).toBe(roots === 0 ? 0 : 1);
      expect(instrumentation.visibilityReconcileVisits).toBe(0);
      expect(preparation).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      insert.mockRestore();
      observe.mockRestore();
      let remaining = 20;
      while (reconciler.hasPendingWork) {
        expect(remaining--).toBeGreaterThan(0);
        reconciler.reconcile(time + 8, () => time, new Map(), new Map(), { remainingRoots: 64 });
      }
      expect(remove).toHaveBeenCalledOnce();
      expect(preparation.mock.calls.length > 0).toBe(pressure);
    } finally {
      insert.mockRestore();
      observe.mockRestore();
      preparation.mockRestore();
      remove.mockRestore();
      reconciler.release();
      paths.release();
      visibility.release();
      dom.release();
    }
  },
);

function retainedReorderFixture(pressure: boolean) {
  const document = new FakeDocument();
  const dom = new SceneDom(asElement(new FakeNode(document, "div")), "Canvas", {});
  const instrumentation = createInstrumentation();
  const store = new FakeSceneStore();
  const mounted = new Map<string, MountedSceneElement>();
  for (const record of [
    fakeRectangleRecord("exit", 3, 20, 1_030),
    fakeRectangleRecord("first", 1, 20, 10),
    fakeRectangleRecord("last", 2, 20, 10),
  ]) {
    store.records.set(record.id, record);
    const entry = createMountedElement(
      dom.ownerDocument,
      record,
      buildElementPathParts(record.element),
      instrumentation,
    );
    entry.committedOrderEpoch = -1;
    mounted.set(record.id, entry);
  }
  const content = fakeNode(dom.contentGroup);
  content.append(
    fakeNode(mounted.get("last")!.paths[0]!.node),
    fakeNode(mounted.get("first")!.paths[0]!.node),
    fakeNode(mounted.get("exit")!.paths[0]!.node),
  );
  if (pressure) {
    const stroke = {
      ...indexedStroke(30_001),
      pivot: { x: 20, y: 10 },
      points: [20, 10, 0.5, 30, 10, 0.5],
    };
    store.records.set(stroke.id, createSceneRecord(stroke, 0));
  }
  const visibility = new SceneVisibilityState(store, instrumentation);
  const target = visibility.query({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
  const paths = new ScenePathCache();
  const reconciler = new SceneVisibilityReconciler({
    dom,
    instrumentation,
    mounted,
    orderDirty: { content: new Set(), highlight: new Set() },
    pathCache: paths,
    store,
    visibility,
  });
  reconciler.replace(target.visibility, true);
  return {
    reconciler,
    dom,
    instrumentation,
    paths,
    visibility,
    exit: fakeNode(mounted.get("exit")!.paths[0]!.node),
  };
}
