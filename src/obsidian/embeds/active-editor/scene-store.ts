import { renderBandOf, type RenderBand } from "../../../domain/commands/render-bands";
import type { Bounds } from "../../../domain/geometry/public";
import { FILE_SCHEMA_LIMITS, type InkElementV1, type PointV1 } from "../../../domain/schema/public";
import { SpatialQueryScratch } from "../../../domain/spatial/index";
import type { ElementStore } from "../../../domain/store/public";
import { HitTestScratch } from "../../../editor/selection/public";
import type { SnapTarget } from "../../../editor/snapping/snap-candidate";
import type { SceneStorePort, SpatialQuerySink } from "../../../rendering/scene/index";
import type { ActiveDocumentMemoryStorePort } from "../../../editor/session/active-document-memory-coordinator";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { ConnectionCycleCache } from "./connection-cycle-cache";
import { isAnchorTarget } from "../../../domain/geometry/anchors";
import { mayHaveAnchorInBounds } from "../../../domain/geometry/anchor-query";

export class ElementSceneStore implements SceneStorePort, ActiveDocumentMemoryStorePort {
  readonly #hitScratch = new HitTestScratch();
  readonly #hitSink: SpatialQuerySink = { add: (id) => this.#considerHit(id) };
  readonly #scratch = new SpatialQueryScratch<string>();
  readonly #store: ElementStore;
  readonly #connections: ConnectionCycleCache;
  readonly #unsubscribeMemoryUsage: () => void;

  public constructor(store: ElementStore, onMemoryUsageChanged: () => void = () => undefined) {
    this.#store = store;
    this.#connections = new ConnectionCycleCache(store, onMemoryUsageChanged);
    this.#unsubscribeMemoryUsage = store.subscribeMemoryUsage(onMemoryUsageChanged);
  }
  public prepareScenePaths: SceneStorePort["prepareScenePaths"];

  public get(id: string): ReturnType<SceneStorePort["get"]> {
    const record = this.#store.get(id);
    const rank = this.#store.getRank(id);
    if (record === undefined || rank === undefined) return undefined;
    return {
      band: renderBandOf(record.element),
      bounds: record.bounds,
      element: record.element as InkElementV1,
      geometryVersion: record.geometryVersion,
      id,
      paintVersion: record.paintVersion,
      rank: rank.rank,
    };
  }

  public pressureGeometry(id: string, geometryVersion: number) {
    return this.#store.pressureGeometry(id, geometryVersion);
  }

  public beginQuery(bounds: Bounds): ReturnType<ElementStore["beginQuery"]> {
    return this.#store.beginQuery(bounds);
  }

  public readRevision(): number {
    return this.#store.mutationVersion;
  }

  public beginOrder(): ReturnType<ElementStore["beginOrder"]> {
    return this.#store.beginOrder();
  }

  public query(bounds: Bounds, sink: SpatialQuerySink): void {
    const count = this.#store.query(bounds, this.#scratch);
    for (let index = 0; index < count; index += 1) sink.add(this.#scratch.at(index));
  }

  public getSnapTarget(id: string, bounds?: Bounds): SnapTarget | null {
    if (bounds !== undefined) {
      const element = this.#store.get(id)?.element;
      if (
        element === undefined ||
        !isAnchorTarget(element) ||
        !mayHaveAnchorInBounds(element, bounds)
      )
        return null;
    }
    const anchors = this.#store.getSemanticAnchors(id);
    const rank = this.#store.getRank(id);
    return anchors === null || rank === undefined
      ? null
      : {
          anchors,
          rank: rank.rank + (rank.band === "content" ? FILE_SCHEMA_LIMITS.elements : 0),
        };
  }

  public canConnect(sourceId: string, targetId: string): boolean {
    return this.#connections.canConnect(sourceId, targetId);
  }

  public prepareConnections(
    sourceId: string,
    scheduler: WorkScheduler,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.#connections.prepare(sourceId, scheduler, signal);
  }

  public clearConnections(): void {
    this.#connections.clear();
  }

  public memoryUsage(): ReturnType<ActiveDocumentMemoryStorePort["memoryUsage"]> {
    const usage = this.#store.activeDocumentMemoryUsage();
    return {
      ...usage,
      selectionGeometryCacheBytes:
        (usage.selectionGeometryCacheBytes ?? 0) + this.#connections.memoryUsage(),
      pressurePathCacheBytes: usage.pressurePathCacheBytes,
    };
  }

  public setActiveDocumentMemoryPressure(active: boolean): void {
    this.#store.setActiveDocumentMemoryPressure(active);
    this.#connections.setMemoryPressure(active);
  }

  public materializeBandOrder(band: "content" | "highlight"): readonly string[] {
    return this.#store.materializeBandOrder(band);
  }

  public bandSize(band: RenderBand): number {
    return this.#store.bandSize(band);
  }

  public hit(point: PointV1, pointerType: "mouse" | "pen" | "touch", zoom: number): string | null {
    if (!Number.isFinite(zoom) || zoom <= 0) return null;
    const radius = (pointerType === "touch" ? 14 : 8) / zoom;
    this.#hitScratch.begin(point, pointerType, zoom);
    this.query(
      {
        minX: point.x - radius,
        minY: point.y - radius,
        maxX: point.x + radius,
        maxY: point.y + radius,
      },
      this.#hitSink,
    );
    return this.#hitScratch.finish();
  }

  #considerHit(id: string): void {
    const record = this.get(id);
    if (record === undefined) return;
    this.#hitScratch.consider(
      id,
      record.band,
      record.element,
      record.rank,
      this.pressureGeometry(id, record.geometryVersion),
    );
  }

  public release(): void {
    this.#connections.release();
    this.#unsubscribeMemoryUsage();
    this.#scratch.release();
  }
}
