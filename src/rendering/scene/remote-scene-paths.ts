import {
  MAX_PREPARED_SCENE_PATH_IDS,
  MAX_PREPARED_SCENE_PATH_BYTES,
  preparedScenePathBytes,
  type PreparedScenePathEntry,
} from "../../domain/geometry/prepared-scene-paths";
import type { SvgPathPart } from "../../domain/geometry/svg-path-part";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import type { SceneElementRecord, SceneStorePort } from "./types";

interface Batch {
  retarget: ((ids: readonly string[]) => void) | undefined;
  readonly controller: AbortController;
  readonly versions: Map<string, number>;
  readonly paths: Map<string, readonly SvgPathPart[]>;
  readonly viewportIds: Set<string>;
  readonly deliveries: (readonly PreparedScenePathEntry[])[];
  readonly maxBytes: number;
  bytes: number;
  receivedBytes: number;
  processing: boolean;
  started: boolean;
  terminal: boolean;
  pending: boolean;
}

interface RemoteScenePathOptions {
  readonly scheduler?: WorkScheduler;
  readonly isCached?: (record: SceneElementRecord) => boolean;
  readonly isViewport?: (record: SceneElementRecord) => boolean;
  readonly onReady?: () => void;
  readonly onPrepared?: (record: SceneElementRecord, parts: readonly SvgPathPart[]) => void;
}

/** Two bounded batches overlap delivery with publication; only one request runs. */
export class RemoteScenePaths {
  readonly #batches: Batch[] = [];
  #hasPublished = false;
  #upcoming: () => Iterable<string> = () => [];
  #lastReleased: string | undefined;
  #readyCount = 0;
  public constructor(
    private readonly store: SceneStorePort,
    private readonly options: RemoteScenePathOptions = {},
  ) {}

  public get waiting(): boolean {
    return this.#batches.some((batch) => batch.pending);
  }

  public get readyCount(): number {
    return this.#readyCount;
  }

  public read(
    record: SceneElementRecord,
    upcoming: () => Iterable<string>,
  ): readonly SvgPathPart[] | "pending" | undefined {
    if (this.store.prepareScenePaths === undefined) return undefined;
    this.#upcoming = upcoming;
    let batch = this.#batches.find((candidate) => candidate.versions.has(record.id));
    if (batch === undefined) {
      if (this.waiting) return "pending";
      batch = this.start(record);
      if (batch === undefined) return undefined;
    }
    if (batch.pending && !batch.paths.has(record.id)) return "pending";
    const parts =
      batch.versions.get(record.id) === record.geometryVersion
        ? batch.paths.get(record.id)
        : undefined;
    this.release(record.id);
    return parts;
  }

  /** Cache adoption can bypass read; free the reservation before DOM publication. */
  public release(id: string, upcoming?: () => Iterable<string>): void {
    if (!this.#batches.some((batch) => batch.versions.has(id))) return;
    this.#lastReleased = id;
    if (upcoming !== undefined) this.#upcoming = upcoming;
    for (const batch of this.#batches) this.releaseEntry(batch, id);
    this.prune();
    this.refill();
  }

  public cancel(retainVisible?: (id: string) => boolean): void {
    this.#upcoming = () => [];
    let changed = false;
    for (const batch of this.#batches) {
      if (!batch.started) {
        this.abort(batch);
        changed = true;
        continue;
      }
      let shrunk = false;
      for (const [id, version] of batch.versions) {
        if (retainVisible?.(id) === true && this.store.get(id)?.geometryVersion === version)
          continue;
        this.releaseEntry(batch, id);
        shrunk = true;
      }
      changed ||= shrunk;
      if (batch.versions.size === 0) this.abort(batch);
      else if (shrunk) batch.retarget?.([...batch.versions.keys()]);
    }
    this.prune();
    if (changed || this.#batches.length === 0)
      this.#hasPublished = this.#batches.some((batch) => batch.paths.size > 0);
    if (retainVisible === undefined) {
      this.#lastReleased = undefined;
    }
  }

  public memoryUsage(): number {
    return this.#batches.reduce(
      (bytes, batch) =>
        bytes + (batch.pending ? batch.maxBytes : batch.bytes) + batch.versions.size * 128,
      0,
    );
  }

  private abort(batch: Batch): void {
    batch.controller.abort();
    this.discardReadyPaths(batch);
    batch.versions.clear();
    batch.viewportIds.clear();
  }

  private discardReadyPaths(batch: Batch): void {
    batch.deliveries.length = 0;
    this.#readyCount -= batch.paths.size;
    batch.paths.clear();
    batch.bytes = 0;
  }

  private releaseEntry(batch: Batch, id: string): void {
    const parts = batch.paths.get(id);
    if (parts !== undefined) {
      batch.bytes -= preparedScenePathBytes(id, parts);
      this.#readyCount--;
    }
    batch.versions.delete(id);
    batch.paths.delete(id);
    batch.viewportIds.delete(id);
  }

  private prune(): void {
    for (let index = this.#batches.length - 1; index >= 0; index -= 1) {
      const batch = this.#batches[index]!;
      if (batch.controller.signal.aborted || (!batch.pending && batch.versions.size === 0)) {
        this.#readyCount -= batch.paths.size;
        this.#batches.splice(index, 1);
      }
    }
  }

  private refill(): void {
    if (!this.#hasPublished || this.waiting || this.#batches.length >= 2) return;
    // Half-pool occupancy overlaps preparation with the retained publication tail.
    // This coalesces protocol requests without limiting admitted CPU work.
    if (this.capacity() >= MAX_PREPARED_SCENE_PATH_IDS / 2) this.start();
  }

  private capacity(): number {
    return (
      MAX_PREPARED_SCENE_PATH_IDS -
      this.#batches.reduce((count, batch) => count + batch.versions.size, 0)
    );
  }

  private start(required?: SceneElementRecord): Batch | undefined {
    const maxBytes =
      MAX_PREPARED_SCENE_PATH_BYTES -
      this.#batches.reduce((bytes, batch) => bytes + batch.bytes, 0);
    if (this.#batches.length >= 2 || this.capacity() === 0 || maxBytes <= 0) return undefined;
    const batch: Batch = {
      retarget: undefined,
      controller: new AbortController(),
      versions: new Map(),
      paths: new Map(),
      viewportIds: new Set(),
      deliveries: [],
      maxBytes,
      bytes: 0,
      receivedBytes: 0,
      processing: false,
      started: false,
      terminal: false,
      pending: true,
    };
    if (required !== undefined) this.add(batch, required);
    this.#batches.push(batch);
    // The first contour remains independent of bulk lookahead.
    if (!this.#hasPublished && required !== undefined) this.dispatch(batch);
    else void this.collect(batch).catch(() => this.fail(batch));
    return batch;
  }

  private add(batch: Batch, record: SceneElementRecord): void {
    batch.versions.set(record.id, record.geometryVersion);
    if (this.options.isViewport?.(record) !== false) batch.viewportIds.add(record.id);
  }

  private async collect(batch: Batch): Promise<void> {
    const iterator = this.#upcoming()[Symbol.iterator]();
    while (this.capacity() > 0 && !batch.controller.signal.aborted) {
      const wait =
        this.options.scheduler?.shouldYield() === true
          ? this.options.scheduler.checkpoint(batch.controller.signal, "frame")
          : undefined;
      if (wait !== undefined) await wait;
      if (batch.controller.signal.aborted) return;
      const next = iterator.next();
      if (next.done === true) break;
      if (next.value === this.#lastReleased) continue;
      if (this.#batches.some((candidate) => candidate.versions.has(next.value))) continue;
      const candidate = this.store.get(next.value);
      if (candidate?.element.kind !== "stroke" || this.options.isCached?.(candidate) === true)
        continue;
      this.add(batch, candidate);
    }
    if (batch.controller.signal.aborted) return;
    if (batch.versions.size === 0) {
      batch.pending = false;
      this.prune();
    } else this.dispatch(batch);
  }

  private dispatch(batch: Batch): void {
    batch.started = true;
    const visible = [...batch.versions.keys()].filter((id) => batch.viewportIds.has(id));
    const overscan = [...batch.versions.keys()].filter((id) => !batch.viewportIds.has(id));
    const ids = [...visible, ...overscan];
    const versions = new Map(batch.versions);
    batch.versions.clear();
    for (const id of ids) batch.versions.set(id, versions.get(id)!);
    void this.store.prepareScenePaths!(ids, batch.controller.signal, {
      visibleCount: visible.length,
      maxBytes: batch.maxBytes,
      onProgress: (paths) => this.enqueue(batch, paths),
      setRetarget: (handler) => {
        batch.retarget = handler;
        if (handler !== undefined) handler([...batch.versions.keys()]);
      },
    }).then(
      (paths) => this.enqueue(batch, paths ?? [], true),
      () => this.fail(batch),
    );
  }

  private enqueue(batch: Batch, paths: readonly PreparedScenePathEntry[], terminal = false): void {
    if (batch.controller.signal.aborted || !this.#batches.includes(batch)) return;
    if (paths.length > 0) batch.deliveries.push(paths);
    batch.terminal ||= terminal;
    if (!batch.processing) void this.adopt(batch).catch(() => this.fail(batch));
  }

  private async adopt(batch: Batch): Promise<void> {
    batch.processing = true;
    let ready = false;
    while (batch.deliveries.length > 0) {
      const delivery = batch.deliveries[0]!;
      for (const path of delivery) {
        const wait =
          this.options.scheduler?.shouldYield() === true
            ? this.options.scheduler.checkpoint(batch.controller.signal, "frame")
            : undefined;
        if (wait !== undefined) {
          if (ready) this.options.onReady?.();
          ready = false;
          await wait;
        }
        if (batch.controller.signal.aborted) return;
        ready = this.adoptPath(batch, path) || ready;
      }
      batch.deliveries.shift();
    }
    batch.processing = false;
    if (batch.terminal) {
      batch.pending = false;
      this.prune();
      this.refill();
    }
    if (ready || batch.terminal) this.options.onReady?.();
  }

  private adoptPath(batch: Batch, path: PreparedScenePathEntry): boolean {
    const bytes = preparedScenePathBytes(path.id, path.parts);
    batch.receivedBytes += bytes;
    if (batch.receivedBytes > batch.maxBytes) {
      this.fail(batch);
      return false;
    }
    if (!batch.versions.has(path.id) || batch.paths.has(path.id)) return false;
    const record = this.store.get(path.id);
    if (record === undefined || batch.versions.get(path.id) !== record.geometryVersion)
      return false;
    batch.paths.set(path.id, path.parts);
    this.#readyCount++;
    batch.bytes += bytes;
    this.#hasPublished = true;
    this.options.onPrepared?.(record, path.parts);
    return true;
  }

  private fail(batch: Batch): void {
    if (batch.controller.signal.aborted || !this.#batches.includes(batch)) return;
    batch.controller.abort();
    this.discardReadyPaths(batch);
    batch.pending = false;
    batch.processing = false;
    // Failed IDs retain their one-read fallback until release or cancellation.
    this.#hasPublished = this.#batches.some((candidate) => candidate.paths.size > 0);
    this.options.onReady?.();
  }
}
