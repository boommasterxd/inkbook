import { MAX_PREPARED_SCENE_PATH_IDS as MAX_SCENE_PATH_IDS } from "../../../domain/geometry/prepared-scene-paths";
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

export function scenePathBytes(id: string, d: string): number {
  return 64 + (id.length + d.length) * 2;
}
