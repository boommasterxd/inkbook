import { renderBandOf } from "../../../src/domain/commands/render-bands";
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
  options: Pick<SceneRendererOptions, "onSceneCommitted" | "deferInitialOverscan"> & {
    readonly frameBudgetMs?: number | (() => number);
  } = {},
  scheduler = new FakeScheduler(options.frameBudgetMs),
) {
  const document = new FakeDocument();
  const renderer = new SvgSceneRenderer({
    ...(options.deferInitialOverscan === undefined
      ? {}
      : { deferInitialOverscan: options.deferInitialOverscan }),
    ...(options.onSceneCommitted === undefined
      ? {}
      : { onSceneCommitted: options.onSceneCommitted }),
    container: asElement(new FakeNode(document, "div")),
    layout: { readViewport: () => viewport },
    page,
    store,
    workScheduler: scheduler.workScheduler,
  });
  return { document, renderer, scheduler };
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
