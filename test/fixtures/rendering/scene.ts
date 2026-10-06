import { renderBandOf } from "../../../src/domain/commands/render-bands";
import { vi } from "vitest";
import type { ElementStore } from "../../../src/domain/store/public";
import { calculateElementBounds } from "../../../src/domain/geometry/bounds";
import type { Bounds } from "../../../src/domain/geometry/public";
import type { SceneElementRecord } from "../../../src/rendering/scene/types";
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

/** Observes the actual indexed cell and candidate visits, including resumed cursors. */
export function observeIndexedSceneQueries(store: ElementStore) {
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
