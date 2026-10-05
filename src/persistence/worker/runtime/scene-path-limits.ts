import { MAX_PREPARED_SCENE_PATH_IDS as MAX_SCENE_PATH_IDS } from "../../../domain/geometry/prepared-scene-paths";
import type { SvgPathPart } from "../../../domain/geometry/svg-path-part";
import type { PrepareScenePathsRuntimeRequest } from "./types";
export const MAX_SCENE_PATH_BYTES = 4 * 1024 * 1024;

export function assertScenePathIds(ids: readonly string[]): void {
  if (
    !Array.isArray(ids) ||
    ids.length > MAX_SCENE_PATH_IDS ||
    ids.some((id) => typeof id !== "string" || id.length === 0 || id.length > 128) ||
    new Set(ids).size !== ids.length
  )
    throw new TypeError("Scene preparation IDs exceed the internal protocol limit.");
}

export function scenePathBytes(id: string, parts: readonly SvgPathPart[]): number {
  return 64 + id.length * 2 + parts.reduce((bytes, part) => bytes + 64 + part.d.length * 2, 0);
}

/** An operation owns its validated IDs; caller mutations cannot change response admission. */
export class ScenePathValidationContext {
  public readonly request: PrepareScenePathsRuntimeRequest;
  readonly #positions: ReadonlyMap<string, number>;
  public constructor(request: PrepareScenePathsRuntimeRequest) {
    if (!Array.isArray(request.ids) || request.ids.length > MAX_SCENE_PATH_IDS)
      throw new TypeError("Scene preparation IDs exceed the internal protocol limit.");
    const ids = [...(request.ids as readonly string[])];
    assertScenePathIds(ids);
    this.request = Object.freeze({
      ...request,
      identity: Object.freeze({ ...request.identity }),
      ids: Object.freeze(ids),
    });
    this.#positions = new Map(ids.map((id, index) => [id, index]));
  }

  public position(id: string): number {
    return this.#positions.get(id) ?? -1;
  }
}

export interface ValidatedScenePathBatch {
  readonly bytes: number;
  readonly firstIdIndex: number;
  readonly lastIdIndex: number;
}
