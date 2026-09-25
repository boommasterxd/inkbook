import { renderBandOf } from "../../../domain/commands/render-bands";
import type { Bounds } from "../../../domain/geometry/public";
import { FILE_SCHEMA_LIMITS, type InkElementV1, type PointV1 } from "../../../domain/schema/public";
import { SpatialQueryScratch } from "../../../domain/spatial/index";
import type { ElementStore } from "../../../domain/store/public";
import { HitTestScratch } from "../../../editor/selection/public";
import type { SnapTarget } from "../../../editor/snapping/snap-candidate";
import type { SceneStorePort, SpatialQuerySink } from "../../../rendering/scene/index";
import type { ActiveDocumentMemoryStorePort } from "../../../editor/session/active-document-memory-coordinator";

export class ElementSceneStore implements SceneStorePort, ActiveDocumentMemoryStorePort {
  readonly #hitScratch = new HitTestScratch();
  readonly #hitSink: SpatialQuerySink = { add: (id) => this.#considerHit(id) };
  readonly #scratch = new SpatialQueryScratch<string>();
  readonly #store: ElementStore;
  readonly #unsubscribeMemoryUsage: () => void;

  public constructor(store: ElementStore, onMemoryUsageChanged: () => void = () => undefined) {
    this.#store = store;
    this.#unsubscribeMemoryUsage = store.subscribeMemoryUsage(onMemoryUsageChanged);
  }

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

  public query(bounds: Bounds, sink: SpatialQuerySink): void {
    const count = this.#store.query(bounds, this.#scratch);
    for (let index = 0; index < count; index += 1) sink.add(this.#scratch.at(index));
  }

  public getSnapTarget(id: string): SnapTarget | null {
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
    const pending = [targetId];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (id === sourceId) return false;
      if (visited.has(id)) continue;
      visited.add(id);
      const target = this.#store.get(id)?.element;
      if (target?.kind !== "line" && target?.kind !== "arrow") continue;
      if (target.startConnection !== null) pending.push(target.startConnection.targetId);
      if (target.endConnection !== null) pending.push(target.endConnection.targetId);
    }
    return true;
  }

  public memoryUsage(): ReturnType<ActiveDocumentMemoryStorePort["memoryUsage"]> {
    return this.#store.activeDocumentMemoryUsage();
  }

  public setActiveDocumentMemoryPressure(active: boolean): void {
    this.#store.setActiveDocumentMemoryPressure(active);
  }

  public materializeBandOrder(band: "content" | "highlight"): readonly string[] {
    return this.#store.materializeBandOrder(band);
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
    this.#unsubscribeMemoryUsage();
    this.#scratch.release();
  }
}
