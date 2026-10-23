import {
  MAX_PREPARED_SCENE_PATH_IDS as MAX_SCENE_PATH_IDS,
  MAX_PREPARED_SCENE_PATH_BYTES,
} from "../../../../domain/geometry/prepared-scene-paths";
export { preparedScenePathBytes as scenePathBytes } from "../../../../domain/geometry/prepared-scene-paths";
import type { PrepareScenePathsRuntimeRequest } from "../types";
export const MAX_SCENE_PATH_BYTES = MAX_PREPARED_SCENE_PATH_BYTES;

export function assertScenePathMaxBytes(maxBytes: number | undefined): number {
  if (
    maxBytes !== undefined &&
    (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_SCENE_PATH_BYTES)
  )
    throw new TypeError("Invalid scene preparation byte capacity.");
  return maxBytes ?? MAX_SCENE_PATH_BYTES;
}

export function assertScenePathVisibleCount(visibleCount: number | undefined, count: number): void {
  if (
    visibleCount !== undefined &&
    (!Number.isSafeInteger(visibleCount) || visibleCount < 0 || visibleCount > count)
  )
    throw new TypeError("Invalid scene preparation visible prefix.");
}

export function assertScenePathIds(ids: readonly string[]): void {
  if (
    !Array.isArray(ids) ||
    ids.length > MAX_SCENE_PATH_IDS ||
    ids.some((id) => typeof id !== "string" || id.length === 0 || id.length > 128) ||
    new Set(ids).size !== ids.length
  )
    throw new TypeError("Scene preparation IDs exceed the internal protocol limit.");
}

export function assertScenePathRequest(request: PrepareScenePathsRuntimeRequest): number {
  assertScenePathIds(request.ids);
  assertScenePathVisibleCount(request.visibleCount, request.ids.length);
  const maxBytes = assertScenePathMaxBytes(request.maxBytes);
  if (request.streamProgress !== undefined && typeof request.streamProgress !== "boolean")
    throw new TypeError("Invalid scene preparation progress mode.");
  if (request.speculative !== undefined && typeof request.speculative !== "boolean")
    throw new TypeError("Invalid scene preparation priority mode.");
  if (
    (request.navigationReserve !== undefined && typeof request.navigationReserve !== "boolean") ||
    (request.navigationReserve === true && request.speculative !== true)
  )
    throw new TypeError("Invalid scene preparation navigation reserve.");
  return maxBytes;
}

/** An operation owns its validated IDs; caller mutations cannot change response admission. */
export class ScenePathValidationContext {
  public readonly request: PrepareScenePathsRuntimeRequest;
  readonly #positions: ReadonlyMap<string, number>;
  public constructor(request: PrepareScenePathsRuntimeRequest) {
    if (!Array.isArray(request.ids) || request.ids.length > MAX_SCENE_PATH_IDS)
      throw new TypeError("Scene preparation IDs exceed the internal protocol limit.");
    const ids = [...(request.ids as readonly string[])];
    const owned = { ...request, ids };
    assertScenePathRequest(owned);
    this.request = Object.freeze({
      ...owned,
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
