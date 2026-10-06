import {
  MAX_PREPARED_SCENE_PATH_BYTES,
  MAX_PREPARED_SCENE_PATH_IDS,
  preparedScenePathBytes,
  type PreparedScenePathEntry,
} from "../../domain/geometry/prepared-scene-paths";
import type { StoreOrderCursor } from "../../domain/store/order-cursor";
import type { ScenePathCache } from "./path-cache";
import type { SceneStoreDelta, SceneStorePort } from "./types";

interface DocumentPathBatch {
  readonly controller: AbortController;
  readonly versions: Map<string, number>;
  readonly received: Set<string>;
  readonly ready: PreparedScenePathEntry[];
  readonly maxBytes: number;
  bytes: number;
  terminal: boolean;
  failed: boolean;
  capacityRefused: boolean;
}

/** Quiet-time contours use the document worker and spare geometry-cache capacity. */
export class DocumentPathPreparation {
  #cursor: StoreOrderCursor | undefined;
  readonly #retry = new Set<string>();
  #orderComplete = false;
  #batch: DocumentPathBatch | undefined;
  #unavailable = false;
  #released = false;

  public constructor(
    private readonly store: SceneStorePort,
    private readonly cache: ScenePathCache,
    private readonly onReady: () => void,
  ) {}

  public get needsWork(): boolean {
    return (
      !this.#released &&
      !this.#unavailable &&
      this.store.beginOrder !== undefined &&
      this.store.prepareScenePaths !== undefined &&
      (this.#batch !== undefined || !this.#orderComplete || this.#retry.size > 0)
    );
  }

  public memoryUsage(): number {
    return (
      (this.#cursor?.memoryUsage() ?? 0) +
      this.#retry.size * 128 +
      (this.#batch === undefined ? 0 : this.#batch.maxBytes + this.#batch.versions.size * 128)
    );
  }

  /** Cursor progress survives input, navigation, and suspended worker requests. */
  public pause(): void {
    const batch = this.#batch;
    this.#batch = undefined;
    if (batch !== undefined) {
      batch.controller.abort();
      for (const id of batch.versions.keys()) this.#retry.add(id);
      batch.ready.length = 0;
    }
    this.#unavailable = false;
  }

  public invalidate(delta: SceneStoreDelta): void {
    this.pause();
    for (const entry of delta.affected) {
      if (entry.after === null) this.#retry.delete(entry.id);
      else if (entry.domains.includes("geometry")) this.#retry.add(entry.id);
    }
  }

  public release(): void {
    this.pause();
    this.#cursor?.cancel();
    this.#cursor = undefined;
    this.#retry.clear();
    this.#released = true;
  }

  /** Returns true only when another admitted frame can perform synchronous work. */
  public prepare(deadline: number, now: () => number): boolean {
    if (!this.needsWork) return false;
    if (this.#batch !== undefined) return this.adopt(deadline, now);
    const maxBytes = Math.min(MAX_PREPARED_SCENE_PATH_BYTES, this.cache.speculativeCapacityBytes());
    if (maxBytes === 0) return false;
    const versions = new Map<string, number>();
    while (versions.size < MAX_PREPARED_SCENE_PATH_IDS && now() < deadline) {
      const id = this.nextId();
      if (id === undefined) break;
      const record = this.store.get(id);
      if (record?.element.kind !== "stroke") continue;
      const pressure = this.store.pressureGeometry?.(id, record.geometryVersion);
      if (this.cache.has(id, record.geometryVersion) || this.cache.read(record.element, pressure))
        continue;
      versions.set(id, record.geometryVersion);
    }
    if (versions.size === 0) return !this.#orderComplete || this.#retry.size > 0;
    const batch: DocumentPathBatch = {
      controller: new AbortController(),
      versions,
      received: new Set(),
      ready: [],
      maxBytes,
      bytes: 0,
      terminal: false,
      failed: false,
      capacityRefused: false,
    };
    this.#batch = batch;
    void this.dispatch(batch);
    return false;
  }

  private nextId(): string | undefined {
    const retry = this.#retry.values().next().value;
    if (retry !== undefined) {
      this.#retry.delete(retry);
      return retry;
    }
    if (this.#orderComplete) return undefined;
    this.#cursor ??= this.store.beginOrder!();
    let step = this.#cursor.advance();
    if (step.stale) {
      this.#cursor.cancel();
      this.#cursor = this.store.beginOrder!();
      step = this.#cursor.advance();
    }
    if (step.done) {
      this.#cursor.cancel();
      this.#cursor = undefined;
      this.#orderComplete = true;
    }
    return step.id;
  }

  private async dispatch(batch: DocumentPathBatch): Promise<void> {
    try {
      const paths = await this.store.prepareScenePaths!(
        [...batch.versions.keys()],
        batch.controller.signal,
        {
          speculative: true,
          navigationReserve: false,
          maxBytes: batch.maxBytes,
          onProgress: (paths) => this.receive(batch, paths),
          setRetarget: () => undefined,
        },
      );
      if (this.#batch !== batch) return;
      if (paths === undefined) batch.failed = true;
      else this.receive(batch, paths);
    } catch {
      if (this.#batch !== batch) return;
      batch.failed = true;
    }
    if (this.#batch !== batch) return;
    batch.terminal = true;
    this.onReady();
  }

  private receive(batch: DocumentPathBatch, paths: readonly PreparedScenePathEntry[]): void {
    if (this.#batch !== batch || batch.controller.signal.aborted) return;
    for (const path of paths) {
      if (!batch.versions.has(path.id) || batch.received.has(path.id)) continue;
      const bytes = preparedScenePathBytes(path.id, path.parts);
      if (batch.bytes + bytes > batch.maxBytes) {
        batch.controller.abort();
        batch.failed = true;
        batch.terminal = true;
        this.onReady();
        return;
      }
      batch.bytes += bytes;
      batch.received.add(path.id);
      batch.ready.push(path);
    }
    if (batch.ready.length > 0) this.onReady();
  }

  private adopt(deadline: number, now: () => number): boolean {
    const batch = this.#batch!;
    while (batch.ready.length > 0 && now() < deadline) {
      const path = batch.ready.shift()!;
      const record = this.store.get(path.id);
      if (record === undefined || record.geometryVersion !== batch.versions.get(path.id)) continue;
      if (!this.cache.retainSpeculative(path.id, record.geometryVersion, path.parts)) {
        batch.capacityRefused = true;
        this.#retry.add(path.id);
        continue;
      }
      batch.versions.delete(path.id);
    }
    if (batch.ready.length > 0) return true;
    if (!batch.terminal) return false;
    this.#batch = undefined;
    for (const id of batch.versions.keys()) this.#retry.add(id);
    // A refused or empty batch waits for an explicit context change instead of polling.
    this.#unavailable = batch.failed || batch.capacityRefused || batch.received.size === 0;
    return this.needsWork;
  }
}
