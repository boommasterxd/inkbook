import type { SvgPathPart } from "./svg-path-part";

/** Bounded, internally generated local contours; never imported SVG markup. */
export interface PreparedScenePathEntry {
  readonly id: string;
  readonly parts: readonly SvgPathPart[];
}

export const MAX_PREPARED_SCENE_PATH_IDS = 256;

export type ScenePathPreparation = (
  ids: readonly string[],
  signal: AbortSignal,
) => Promise<readonly PreparedScenePathEntry[] | undefined>;
