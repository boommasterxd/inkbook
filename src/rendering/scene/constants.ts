import type { SceneCamera } from "./types";

export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
export const VIEWPORT_OVERSCAN_SCREEN_PX = 80;
export const VISIBILITY_HYSTERESIS_RESERVE_SCREEN_PX = 40;
export const PATH_CACHE_MAX_ENTRIES = 4_096;
export const PATH_CACHE_MAX_BYTES = 32 * 1_024 * 1_024;
export const DEFAULT_CAMERA: SceneCamera = Object.freeze({ x: 0, zoom: 1 });
export const SCENE_PUBLICATION_ROOTS_PER_FRAME = 64;
// Use the stricter supported profile because the scene renderer is platform-neutral.
export const DENSE_RECONCILIATION_VISIBLE_ELEMENT_THRESHOLD = 900;
