import { renderBandOf } from "../../../src/domain/commands/render-bands";
import { UniformSpatialIndex } from "../../../src/domain/spatial";
import { expect, vi, type Mock } from "vitest";
import {
  ElementStore,
  type AppliedElementMutation,
  type StoreDelta,
} from "../../../src/domain/store/public";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import { takeImmutableElementOwnership } from "../../../src/domain/store/records/immutability";
import { indexedStroke } from "../editor/stroke";
import { createWorkerSnapshot } from "../persistence/worker-snapshot";
import { calculateElementBounds } from "../../../src/domain/geometry/bounds";
import { buildElementPathParts } from "../../../src/domain/geometry/element-path";
import { roundCanonical } from "../../../src/domain/geometry/primitives";
import type {
  PreparedScenePathEntry,
  ScenePathPreparation,
} from "../../../src/domain/geometry/prepared-scene-paths";
import type { NavigationPathPreparation } from "../../../src/rendering/scene/content/navigation-path-preparation";
import type { SceneVisibilityPriority } from "../../../src/rendering/scene/visibility/scene-entrant-priority";
import type { Bounds } from "../../../src/domain/geometry/public";
import type { SceneDeltaEntry, SceneElementRecord } from "../../../src/rendering/scene/types";
import type { InkElementV1, PageV1 } from "../../../src/domain/schema/public";
import type { SceneRendererOptions, SceneViewport } from "../../../src/rendering/scene/types";
import {
  SvgSceneRenderer,
  type SceneStorePort,
  type SpatialQuerySink,
} from "../../../src/rendering/scene";
import {
  asElement,
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  FakeScheduler,
  fakeNode,
  fakeRectangleRecord,
} from "../../unit/rendering/scene/fakes";

/** Charges a deterministic spatial-query cost to the shared frame clock. */
export class QueryCostStore extends FakeSceneStore {
  public constructor(private readonly scheduler: FakeScheduler) {
    super();
  }

  public override query(bounds: Bounds, sink: SpatialQuerySink): void {
    super.query(bounds, sink);
    this.scheduler.time += 9;
  }
}

export function createSceneFixture(
  page: PageV1,
  store: SceneStorePort,
  viewport: SceneViewport = { height: 1000, left: 0, top: 0, width: 2048 },
  options: Pick<
    SceneRendererOptions,
    | "onSceneCommitted"
    | "deferInitialOverscan"
    | "isInputActive"
    | "waitForBackground"
    | "onResourceUsageChanged"
    | "scrollPreloadMarginPx"
  > & {
    readonly frameBudgetMs?: number | (() => number);
  } = {},
  scheduler = new FakeScheduler(options.frameBudgetMs),
) {
  const parentDocument = new FakeDocument();
  const renderer = new SvgSceneRenderer({
    ...(options.scrollPreloadMarginPx === undefined
      ? {}
      : { scrollPreloadMarginPx: options.scrollPreloadMarginPx }),
    ...(options.isInputActive === undefined ? {} : { isInputActive: options.isInputActive }),
    ...(options.waitForBackground === undefined
      ? {}
      : { waitForBackground: options.waitForBackground }),
    ...(options.deferInitialOverscan === undefined
      ? {}
      : { deferInitialOverscan: options.deferInitialOverscan }),
    ...(options.onSceneCommitted === undefined
      ? {}
      : { onSceneCommitted: options.onSceneCommitted }),
    ...(options.onResourceUsageChanged === undefined
      ? {}
      : { onResourceUsageChanged: options.onResourceUsageChanged }),
    container: asElement(new FakeNode(parentDocument, "div")),
    layout: { readViewport: () => viewport },
    page,
    store,
    workScheduler: scheduler.workScheduler,
  });
  return { document: fakeNode(renderer.svg).ownerDocument, parentDocument, renderer, scheduler };
}

/** Projects committed records and bounds into the renderer's delta adapter. */
export function sceneDeltaEntries(delta: StoreDelta): SceneDeltaEntry[] {
  return delta.changes.map((change) => ({
    id: change.id,
    domains: change.domains,
    before: (change.before?.element as InkElementV1 | undefined) ?? null,
    after: (change.after?.element as InkElementV1 | undefined) ?? null,
    beforeBounds: change.before?.bounds ?? null,
    afterBounds: change.after?.bounds ?? null,
  }));
}

/** Immutable samples can be reused while every history scene owns its Store and caches. */
export function createHistoryContourElements(): readonly InkElementV1[] {
  return Object.freeze(
    Array.from({ length: 10_000 }, (_, index) => {
      const element = indexedStroke(index);
      const stroke = {
        ...element,
        points: Array.from({ length: 20 + (index % 61) }, (_, sample) => [
          roundCanonical(element.pivot.x + sample / 10),
          roundCanonical(element.pivot.y + Math.sin(sample / 5) * 2),
          roundCanonical(0.3 + ((index + sample) % 7) / 10),
        ]).flat(),
      };
      takeImmutableElementOwnership(stroke);
      return stroke;
    }),
  );
}

/** Real committed Store deltas in a 10,000-stroke document, including history provenance. */
export function createHistoryContourScene(inputs?: {
  readonly elements: readonly InkElementV1[];
  readonly paths: readonly PreparedScenePathEntry[];
}) {
  const elements = inputs?.elements ?? createHistoryContourElements();
  const store = new ElementStore(elements);
  const sceneStore = new ElementSceneStore(store);
  const paths = new Map(inputs?.paths.map(({ id, parts }) => [id, parts]));
  sceneStore.pressureGeometry = (id, version) => {
    const port = store.pressureGeometry(id, version);
    const parts = paths.get(id);
    if (version === 0 && parts !== undefined) port.publishPath!(parts);
    return port;
  };
  const scene = createSceneFixture(createWorkerSnapshot([]).page, sceneStore, {
    height: 100,
    left: 0,
    top: 0,
    width: 100,
  });
  scene.scheduler.runAll();
  let historyReplay = false;
  const unsubscribe = store.subscribe((delta) =>
    scene.renderer.applyDelta({
      historyReplay,
      affected: delta.changes.map((change) => ({
        ...change,
        before: (change.before?.element as InkElementV1 | undefined) ?? null,
        after: (change.after?.element as InkElementV1 | undefined) ?? null,
      })),
    }),
  );
  return {
    ...scene,
    store,
    /** Share only immutable setup data; replay targets always prepare their own contours. */
    initialInputs: () => {
      const mounted = scene.renderer.mountedIds("content");
      const targets = new Set(mounted.slice(0, 10));
      return Object.freeze({
        elements: Object.freeze(elements.map(({ id }) => store.get(id)!.element as InkElementV1)),
        paths: Object.freeze(
          mounted
            .filter((id) => !targets.has(id))
            .map((id) => {
              const record = store.get(id)!;
              const parts =
                store.pressureGeometry(id, record.geometryVersion).readPath?.() ??
                buildElementPathParts(record.element as InkElementV1);
              return Object.freeze({
                id,
                parts: Object.freeze(parts.map((part) => Object.freeze({ ...part }))),
              });
            }),
        ),
      });
    },
    prepareReplay: (transition: AppliedElementMutation, direction: "forward" | "reverse") => {
      historyReplay = true;
      return store.prepareElementMutation(
        transition[direction],
        { shouldYield: () => false, yieldControl: async () => undefined },
        transition,
      );
    },
    dispose: () => {
      unsubscribe();
      scene.renderer.destroy();
      sceneStore.release();
      paths.clear();
      store.releasePreparedPressureGeometry();
    },
  };
}

/** Publishes a versioned geometry replacement through the matching committed scene delta. */
export function commitSceneGeometry(
  fixture: { readonly store: FakeSceneStore; readonly renderer: SvgSceneRenderer },
  before: InkElementV1,
  after: InkElementV1,
  geometryVersion: number,
): void {
  fixture.store.records.set(after.id, {
    ...fixture.store.records.get(after.id)!,
    element: after,
    geometryVersion,
  });
  fixture.renderer.applyDelta({
    affected: [{ id: after.id, before, after, domains: ["geometry"] }],
  });
}

/** Advances animation time while draining the existing coalesced frame queue. */
export function drainHistoryFrames(scheduler: FakeScheduler): void {
  for (let frame = 0; scheduler.pendingCount > 0; frame += 1) {
    expect(frame).toBeLessThan(100);
    scheduler.time += 16;
    scheduler.runNext();
  }
}

export function createViewportRectangleStore(
  count: number,
  yForRank: (rank: number) => number,
): FakeSceneStore {
  const store = new FakeSceneStore();
  for (let rank = 0; rank < count; rank += 1) {
    const record = fakeRectangleRecord(`entry-${rank}`, rank, 20, yForRank(rank));
    store.records.set(record.id, record);
  }
  return store;
}

/** Applies a viewport and drains its coalesced scene publication and cleanup. */
export function flushSceneViewport(
  renderer: SvgSceneRenderer,
  scheduler: FakeScheduler,
  viewport: SceneViewport,
): void {
  renderer.setViewport(viewport);
  scheduler.runAll();
}

export function createSceneRecord(element: InkElementV1, rank = 0): SceneElementRecord {
  return {
    id: element.id,
    element,
    geometryVersion: 1,
    paintVersion: 1,
    rank,
    band: renderBandOf(element),
    bounds: calculateElementBounds(element),
  };
}

/** Updates fixture membership and publishes its matching committed history delta. */
export function replaySceneMembership(
  renderer: SvgSceneRenderer,
  store: FakeSceneStore,
  records: readonly SceneElementRecord[],
  direction: "enter" | "exit",
): void {
  const exiting = direction === "exit";
  for (const record of records) {
    if (exiting) store.records.delete(record.id);
    else store.records.set(record.id, record);
  }
  renderer.applyDelta({
    historyReplay: true,
    affected: records.map(({ id, element, bounds }) => ({
      id,
      domains: ["visibility"],
      before: exiting ? element : null,
      after: exiting ? null : element,
      beforeBounds: exiting ? bounds : null,
      afterBounds: exiting ? null : bounds,
    })),
  });
}

/** Observes the actual indexed cell and candidate visits, including resumed cursors. */
export function observeIndexedSceneQueries(store: Pick<ElementStore, "beginQuery">) {
  const work = { indexedVisits: 0 };
  const originalQuery = store.beginQuery.bind(store);
  const query = vi.spyOn(store, "beginQuery").mockImplementation((bounds) => {
    const cursor = originalQuery(bounds);
    const advance = cursor.advance.bind(cursor);
    cursor.advance = (limit) => {
      const step = advance(limit);
      work.indexedVisits += step.workUnits;
      return step;
    };
    return cursor;
  });
  return { query, work };
}

/** Owns a real scene index and observes cursors while rejecting scan-based fallback. */
export function createIndexedSceneStore(records: FakeSceneStore) {
  const index = new UniformSpatialIndex<string>();
  index.insertMany([...records.records.values()].map(({ id, bounds }) => ({ id, bounds })));
  const { work } = observeIndexedSceneQueries(index);
  const fallback = vi.fn(() => {
    throw new Error("Use the spatial cursor.");
  });
  const store: SceneStorePort = {
    get: (id) => records.get(id),
    beginQuery: (bounds) => index.beginQuery(bounds),
    query: fallback,
  };
  return { store, work, fallback };
}

/** Starts one real directional request and returns the observed transport boundary. */
export function beginNavigationPathRequest(
  fixture: {
    readonly preparation: NavigationPathPreparation;
    readonly prepare: Mock<ScenePathPreparation>;
  },
  priority: SceneVisibilityPriority,
  envelope: Bounds,
) {
  fixture.preparation.setTarget(priority, envelope);
  expect(fixture.preparation.prepare(Infinity, () => 0)).toBe(false);
  expect(fixture.prepare).toHaveBeenCalledOnce();
  return fixture.prepare.mock.calls[0]!;
}

/** A remote geometry boundary that stays pending until its lifecycle aborts it. */
export function createPendingScenePathStore() {
  const store: FakeSceneStore & Pick<SceneStorePort, "prepareScenePaths"> = new FakeSceneStore();
  const signals: AbortSignal[] = [];
  store.prepareScenePaths = (_ids, signal) => {
    signals.push(signal);
    return new Promise<undefined>((resolve) => {
      signal.addEventListener("abort", () => resolve(undefined), { once: true });
    });
  };
  return { store, signals };
}
