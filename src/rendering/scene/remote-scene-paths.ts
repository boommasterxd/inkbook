import { MAX_PREPARED_SCENE_PATH_IDS } from "../../domain/geometry/prepared-scene-paths";
import type { SvgPathPart } from "../../domain/geometry/svg-path-part";
import type { SceneElementRecord, SceneStorePort } from "./types";

interface Batch {
  readonly controller: AbortController;
  readonly versions: Map<string, number>;
  readonly paths: Map<string, readonly SvgPathPart[]>;
  pending: boolean;
}

/** One visible lookahead batch owns bounded returned contours until their mount. */
export class RemoteScenePaths {
  #batch: Batch | undefined;
  public constructor(private readonly store: SceneStorePort) {}

  public read(
    record: SceneElementRecord,
    upcoming: () => Iterable<string>,
  ): readonly SvgPathPart[] | "pending" | undefined {
    if (this.store.prepareScenePaths === undefined) return undefined;
    if (!this.#batch?.versions.has(record.id)) this.start(record, upcoming);
    const batch = this.#batch!;
    if (batch.pending) return "pending";
    const parts =
      batch.versions.get(record.id) === record.geometryVersion
        ? batch.paths.get(record.id)
        : undefined;
    batch.versions.delete(record.id);
    batch.paths.delete(record.id);
    return parts;
  }

  public cancel(): void {
    this.#batch?.controller.abort();
    this.#batch = undefined;
  }

  public memoryUsage(): number {
    let bytes = (this.#batch?.versions.size ?? 0) * 128;
    for (const parts of this.#batch?.paths.values() ?? [])
      for (const part of parts) bytes += 64 + part.d.length * 2;
    return bytes;
  }

  private start(record: SceneElementRecord, upcoming: () => Iterable<string>): void {
    this.cancel();
    const batch: Batch = {
      controller: new AbortController(),
      versions: new Map([[record.id, record.geometryVersion]]),
      paths: new Map(),
      pending: true,
    };
    let visited = 0;
    for (const id of upcoming()) {
      if (++visited > MAX_PREPARED_SCENE_PATH_IDS - 1) break;
      const candidate = this.store.get(id);
      if (candidate?.element.kind === "stroke") batch.versions.set(id, candidate.geometryVersion);
    }
    this.#batch = batch;
    void this.store.prepareScenePaths!([...batch.versions.keys()], batch.controller.signal).then(
      (paths) => {
        if (this.#batch !== batch || batch.controller.signal.aborted) return;
        for (const path of paths ?? [])
          if (batch.versions.has(path.id)) batch.paths.set(path.id, path.parts);
        batch.pending = false;
      },
      () => {
        if (this.#batch === batch) batch.pending = false;
      },
    );
  }
}
