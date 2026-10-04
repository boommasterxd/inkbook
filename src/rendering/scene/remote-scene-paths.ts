import { MAX_PREPARED_SCENE_PATH_IDS } from "../../domain/geometry/prepared-scene-paths";
import type { SvgPathPart } from "../../domain/geometry/svg-path-part";
import type { SceneElementRecord, SceneStorePort } from "./types";

interface Batch {
  retarget: ((ids: readonly string[]) => void) | undefined;
  readonly controller: AbortController;
  readonly sequence: number;
  readonly versions: Map<string, number>;
  readonly paths: Map<string, readonly SvgPathPart[]>;
  pending: boolean;
}

interface RemoteScenePathOptions {
  readonly isCached?: (record: SceneElementRecord) => boolean;
  readonly onReady?: () => void;
  readonly onPrepared?: (record: SceneElementRecord, parts: readonly SvgPathPart[]) => void;
}

/** One visible lookahead batch owns bounded returned contours until their mount. */
export class RemoteScenePaths {
  #batch: Batch | undefined;
  #hasPublished = false;
  #sequence = 0;
  public constructor(
    private readonly store: SceneStorePort,
    private readonly options: RemoteScenePathOptions = {},
  ) {}

  public get waiting(): boolean {
    return this.#batch?.pending === true;
  }

  public read(
    record: SceneElementRecord,
    upcoming: () => Iterable<string>,
  ): readonly SvgPathPart[] | "pending" | undefined {
    if (this.store.prepareScenePaths === undefined) return undefined;
    if (!this.#batch?.versions.has(record.id)) {
      if (this.waiting) return "pending";
      this.start(record, upcoming);
    }
    const batch = this.#batch!;
    if (batch.pending && !batch.paths.has(record.id)) return "pending";
    const parts =
      batch.versions.get(record.id) === record.geometryVersion
        ? batch.paths.get(record.id)
        : undefined;
    batch.versions.delete(record.id);
    batch.paths.delete(record.id);
    return parts;
  }

  public cancel(retainVisible?: (id: string) => boolean): void {
    this.#sequence += 1;
    this.#hasPublished = false;
    const batch = this.#batch;
    if (batch === undefined) return;
    for (const [id, version] of batch.versions) {
      if (retainVisible?.(id) === true && this.store.get(id)?.geometryVersion === version) continue;
      batch.versions.delete(id);
      batch.paths.delete(id);
    }
    if (batch.versions.size > 0) {
      batch.retarget?.([...batch.versions.keys()]);
      return;
    }
    batch.controller.abort();
    this.#batch = undefined;
    this.#hasPublished = false;
  }

  public memoryUsage(): number {
    let bytes = (this.#batch?.versions.size ?? 0) * 128;
    for (const parts of this.#batch?.paths.values() ?? [])
      for (const part of parts) bytes += 64 + part.d.length * 2;
    return bytes;
  }

  private start(record: SceneElementRecord, upcoming: () => Iterable<string>): void {
    const batch: Batch = {
      retarget: undefined,
      controller: new AbortController(),
      sequence: this.#sequence,
      versions: new Map([[record.id, record.geometryVersion]]),
      paths: new Map(),
      pending: true,
    };
    // The first required contour has its own response, so bulk lookahead cannot delay it.
    if (this.#hasPublished) this.addLookahead(batch, upcoming());
    this.#batch = batch;
    void this.store.prepareScenePaths!([...batch.versions.keys()], batch.controller.signal, {
      onProgress: (paths) => this.adopt(batch, paths),
      setRetarget: (handler) => {
        batch.retarget = handler;
        if (handler !== undefined) handler([...batch.versions.keys()]);
      },
    }).then(
      (paths) => {
        if (this.#batch !== batch || batch.controller.signal.aborted) return;
        this.adopt(batch, paths ?? [], false);
        batch.pending = false;
        this.options.onReady?.();
      },
      () => {
        if (this.#batch !== batch || batch.controller.signal.aborted) return;
        batch.pending = false;
        this.options.onReady?.();
      },
    );
  }

  private adopt(
    batch: Batch,
    paths: readonly import("../../domain/geometry/prepared-scene-paths").PreparedScenePathEntry[],
    notify = true,
  ): void {
    if (this.#batch !== batch || batch.controller.signal.aborted) return;
    let ready = false;
    for (const path of paths) {
      if (!batch.versions.has(path.id) || batch.paths.has(path.id)) continue;
      const record = this.store.get(path.id);
      if (record === undefined || batch.versions.get(path.id) !== record.geometryVersion) continue;
      batch.paths.set(path.id, path.parts);
      if (batch.sequence === this.#sequence) this.#hasPublished = true;
      this.options.onPrepared?.(record, path.parts);
      ready = true;
    }
    if (ready && notify) this.options.onReady?.();
  }

  private addLookahead(batch: Batch, upcoming: Iterable<string>): void {
    let visited = 0;
    for (const id of upcoming) {
      if (batch.versions.has(id)) continue;
      if (++visited > MAX_PREPARED_SCENE_PATH_IDS - 1) break;
      const candidate = this.store.get(id);
      if (candidate?.element.kind !== "stroke" || this.options.isCached?.(candidate) === true)
        continue;
      batch.versions.set(id, candidate.geometryVersion);
    }
  }
}
