import type { Bounds } from "../../domain/geometry/primitives";
import {
  MAX_PREPARED_SCENE_PATH_IDS,
  MAX_PREPARED_SCENE_PATH_BYTES,
  preparedScenePathBytes,
  type PreparedScenePathEntry,
} from "../../domain/geometry/prepared-scene-paths";
import type { SvgPathPart } from "../../domain/geometry/svg-path-part";
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

interface RemotePreparation {
  readonly controller: AbortController;
  readonly versions: Map<string, number>;
  readonly ready: PreparedScenePathEntry[];
  readonly received: Set<string>;
  bytes: number;
  terminal: boolean;
  started: boolean;
}

/** One indexed region and its bounded contour preparation share the scene frame deadline. */
export class NavigationPathPreparation {
  #cursor: ReturnType<NonNullable<SceneStorePort["beginQuery"]>> | undefined;
  #target: Bounds | undefined;
  #visible: Bounds | undefined;
  #pending: PendingPath | undefined;
  #visited = 0;
  #complete = true;
  #queryComplete = true;
  #remote: RemotePreparation | undefined;
  #remoteUnavailable = false;

  public constructor(
    private readonly store: SceneStorePort,
    private readonly cache: ScenePathCache,
    private readonly onReady: () => void = () => undefined,
  ) {}

  public memoryUsage(): number {
    return (
      (this.#pending?.path.memoryUsage() ?? 0) +
      (this.#cursor?.memoryUsage?.() ?? 0) +
      (this.#remote === undefined
        ? 0
        : this.#remote.versions.size * 128 + MAX_PREPARED_SCENE_PATH_BYTES)
    );
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
    this.#remoteUnavailable = false;
    this.#complete = this.store.beginQuery === undefined;
    this.#queryComplete = this.#complete;
  }

  /** Returns only unfinished work; reaching the region capacity closes this target. */
  public prepare(deadline: number, now: () => number): boolean {
    if (this.#remote?.started === true) return this.adoptRemote(deadline, now);
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
        if (this.#remote !== undefined) {
          void this.dispatchRemote(this.#remote);
          return false;
        }
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

  /** Required work cancels speculation and suspends the useful local fallback contour. */
  public pause(): void {
    this.#cursor?.cancel();
    this.#cursor = undefined;
    this.#visited = 0;
    this.#queryComplete = false;
    const remote = this.#remote;
    this.#remote = undefined;
    if (remote !== undefined) {
      remote.controller.abort();
      remote.ready.length = 0;
      remote.versions.clear();
      remote.received.clear();
      remote.bytes = 0;
    }
    this.#complete = this.#target === undefined || this.store.beginQuery === undefined;
  }

  private admit(id: string): void {
    this.#visited += 1;
    const record = this.store.get(id);
    if (record?.element.kind !== "stroke" || intersects(this.#visible!, record.bounds)) return;
    const pressure = this.store.pressureGeometry?.(id, record.geometryVersion);
    if (this.cache.has(id, record.geometryVersion) || this.cache.read(record.element, pressure))
      return;
    if (this.store.prepareScenePaths === undefined || this.#remoteUnavailable)
      this.#pending = { record, path: this.cache.startPreparation(record.element, pressure) };
    else {
      this.#remote ??= {
        controller: new AbortController(),
        versions: new Map(),
        ready: [],
        received: new Set(),
        bytes: 0,
        terminal: false,
        started: false,
      };
      this.#remote.versions.set(id, record.geometryVersion);
    }
  }

  private async dispatchRemote(remote: RemotePreparation): Promise<void> {
    remote.started = true;
    try {
      const paths = await this.store.prepareScenePaths!(
        [...remote.versions.keys()],
        remote.controller.signal,
        {
          speculative: true,
          maxBytes: MAX_PREPARED_SCENE_PATH_BYTES,
          onProgress: (paths) => this.receiveRemote(remote, paths),
          setRetarget: () => undefined,
        },
      );
      if (this.#remote !== remote) return;
      if (paths === undefined) this.failRemote(remote);
      else {
        this.receiveRemote(remote, paths);
        remote.terminal = true;
        this.onReady();
      }
    } catch {
      this.failRemote(remote);
    }
  }

  private receiveRemote(remote: RemotePreparation, paths: readonly PreparedScenePathEntry[]): void {
    if (this.#remote !== remote || remote.controller.signal.aborted) return;
    for (const path of paths) {
      if (!remote.versions.has(path.id) || remote.received.has(path.id)) continue;
      remote.bytes += preparedScenePathBytes(path.id, path.parts);
      if (remote.bytes > MAX_PREPARED_SCENE_PATH_BYTES) {
        this.failRemote(remote);
        return;
      }
      remote.received.add(path.id);
      remote.ready.push(path);
    }
    if (remote.ready.length > 0) this.onReady();
  }

  private adoptRemote(deadline: number, now: () => number): boolean {
    const remote = this.#remote!;
    while (remote.ready.length > 0 && now() < deadline) {
      const path = remote.ready.shift()!;
      const record = this.store.get(path.id);
      if (record === undefined || record.geometryVersion !== remote.versions.get(path.id)) continue;
      this.publish(record, path.parts);
    }
    if (remote.ready.length > 0) return true;
    if (remote.terminal) {
      this.#remote = undefined;
      this.#complete = true;
    }
    return false;
  }

  private failRemote(remote: RemotePreparation): void {
    if (this.#remote !== remote) return;
    this.#remoteUnavailable = true;
    this.pause();
    this.onReady();
  }

  private publish(record: SceneElementRecord, parts: readonly SvgPathPart[]): void {
    const pressure = this.store.pressureGeometry?.(record.id, record.geometryVersion);
    localPressureGeometry(record.element, pressure)?.publishPath?.(parts);
    this.cache.completePreparation(record.element, parts);
    this.cache.retain(record.id, record.geometryVersion, parts);
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
      this.publish(pending.record, parts);
      this.#pending = undefined;
      if (this.#queryComplete) this.#complete = true;
      return true;
    }
    return false;
  }
}
