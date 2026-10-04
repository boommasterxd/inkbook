import type { Bounds } from "../../domain/geometry/primitives";
import { MAX_PREPARED_SCENE_PATH_IDS } from "../../domain/geometry/prepared-scene-paths";
import type { ScenePathCache } from "./path-cache";
import type { ProgressivePreviewPath } from "./progressive-preview-path";
import type { SceneVisibilityPriority } from "./scene-entrant-priority";
import type { SceneElementRecord, SceneStorePort } from "./types";
import { intersects, sameBounds } from "./visibility-bounds";
import { localPressureGeometry } from "./stroke-position";

interface PendingPath {
  readonly record: SceneElementRecord;
  readonly path: ProgressivePreviewPath;
}

/** One indexed directional region and one suspended contour share the scene frame deadline. */
export class NavigationPathPreparation {
  #cursor: ReturnType<NonNullable<SceneStorePort["beginQuery"]>> | undefined;
  #target: Bounds | undefined;
  #visible: Bounds | undefined;
  #pending: PendingPath | undefined;
  #visited = 0;
  #complete = true;
  #queryComplete = true;

  public constructor(
    private readonly store: SceneStorePort,
    private readonly cache: ScenePathCache,
  ) {}

  public memoryUsage(): number {
    return (this.#pending?.path.memoryUsage() ?? 0) + (this.#cursor?.memoryUsage?.() ?? 0);
  }

  public setTarget(priority: SceneVisibilityPriority | undefined, envelope: Bounds): void {
    const direction = priority?.direction;
    if (direction === undefined || (direction.x === 0 && direction.y === 0)) {
      this.cancel();
      return;
    }
    const reserveX = (envelope.maxX - envelope.minX) / 2;
    const reserveY = (envelope.maxY - envelope.minY) / 2;
    const target =
      Math.abs(direction.x) > Math.abs(direction.y)
        ? {
            ...envelope,
            minX: direction.x > 0 ? envelope.maxX : envelope.minX - reserveX,
            maxX: direction.x > 0 ? envelope.maxX + reserveX : envelope.minX,
          }
        : {
            ...envelope,
            minY: direction.y > 0 ? envelope.maxY : envelope.minY - reserveY,
            maxY: direction.y > 0 ? envelope.maxY + reserveY : envelope.minY,
          };
    if (sameBounds(this.#target, target)) return;
    this.pause();
    const pending = this.#pending;
    const record = pending === undefined ? undefined : this.store.get(pending.record.id);
    if (
      pending !== undefined &&
      (record?.geometryVersion !== pending.record.geometryVersion ||
        !intersects(target, record.bounds) ||
        intersects(envelope, record.bounds))
    ) {
      pending.path.cancel();
      this.#pending = undefined;
    }
    this.#target = target;
    this.#visible = envelope;
    this.#complete = this.store.beginQuery === undefined;
    this.#queryComplete = this.#complete;
  }

  /** Returns only unfinished work; reaching the region capacity closes this target. */
  public prepare(deadline: number, now: () => number): boolean {
    while (!this.#complete && now() < deadline) {
      if (this.#pending !== undefined) {
        if (!this.preparePending(deadline, now)) return true;
        continue;
      }
      this.#cursor ??= this.store.beginQuery!(this.#target!);
      const step = this.#cursor.advance(1);
      if (step.stale) {
        this.cancel();
        return false;
      }
      for (const id of step.ids) this.admit(id);
      if (step.done || this.#visited >= MAX_PREPARED_SCENE_PATH_IDS) {
        this.#cursor.cancel();
        this.#cursor = undefined;
        this.#queryComplete = true;
        this.#complete = this.#pending === undefined;
        // The last admitted contour still completes under the shared deadline.
        if (this.#pending !== undefined) return !this.preparePending(deadline, now);
      }
    }
    return !this.#complete;
  }

  public cancel(): void {
    this.pause();
    this.#pending?.path.cancel();
    this.#pending = undefined;
    this.#target = undefined;
    this.#visible = undefined;
    this.#complete = true;
    this.#queryComplete = true;
  }

  /** Required scene work suspends the single useful contour and drops obsolete indexed visits. */
  public pause(): void {
    this.#cursor?.cancel();
    this.#cursor = undefined;
    this.#visited = 0;
    this.#queryComplete = false;
  }

  private admit(id: string): void {
    this.#visited += 1;
    const record = this.store.get(id);
    if (record?.element.kind !== "stroke" || intersects(this.#visible!, record.bounds)) return;
    const pressure = this.store.pressureGeometry?.(id, record.geometryVersion);
    if (this.cache.has(id, record.geometryVersion) || this.cache.read(record.element, pressure))
      return;
    this.#pending = { record, path: this.cache.startPreparation(record.element, pressure) };
  }

  private preparePending(deadline: number, now: () => number): boolean {
    const pending = this.#pending!;
    if (this.store.get(pending.record.id)?.geometryVersion !== pending.record.geometryVersion) {
      pending.path.cancel();
      this.#pending = undefined;
      return true;
    }
    while (now() < deadline) {
      if (!pending.path.step(deadline, now)) continue;
      const parts = pending.path.parts!;
      const pressure = this.store.pressureGeometry?.(
        pending.record.id,
        pending.record.geometryVersion,
      );
      localPressureGeometry(pending.record.element, pressure)?.publishPath?.(parts);
      this.cache.completePreparation(pending.record.element, parts);
      this.cache.retain(pending.record.id, pending.record.geometryVersion, parts);
      this.#pending = undefined;
      if (this.#queryComplete) this.#complete = true;
      return true;
    }
    return false;
  }
}
