import { MAX_PREPARED_SCENE_PATH_IDS as MAX_SCENE_PATH_IDS } from "../../../domain/geometry/prepared-scene-paths";
import type { SvgPathPart } from "../../../domain/geometry/svg-path-part";
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
