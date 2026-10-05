import type { SvgPathPart } from "./svg-path-part";

/** Bounded, internally generated local stroke paths; never imported SVG markup. */
export interface PreparedScenePathEntry {
  readonly id: string;
  readonly parts: readonly SvgPathPart[];
}

export const MAX_PREPARED_SCENE_PATH_IDS = 256;
export const MAX_PREPARED_SCENE_PATH_BYTES = 4 * 1024 * 1024;

export function preparedScenePathBytes(id: string, parts: readonly SvgPathPart[]): number {
  return 64 + id.length * 2 + parts.reduce((bytes, part) => bytes + 64 + part.d.length * 2, 0);
}

export interface ScenePathPreparationObserver {
  /** Exact-viewport prefix in the visible-first IDs, excluding overscan. */
  readonly visibleCount?: number;
  /** Available combined contour capacity, bounded by MAX_PREPARED_SCENE_PATH_BYTES. */
  readonly maxBytes?: number;
  onProgress(paths: readonly PreparedScenePathEntry[]): void;
  setRetarget(handler: ((ids: readonly string[]) => void) | undefined): void;
}

export type ScenePathPreparation = (
  ids: readonly string[],
  signal: AbortSignal,
  observer?: ScenePathPreparationObserver,
) => Promise<readonly PreparedScenePathEntry[] | undefined>;
