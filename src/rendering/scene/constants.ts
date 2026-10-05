import type { SceneCamera } from "./types";

export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
export const VIEWPORT_OVERSCAN_SCREEN_PX = 80;
export const VISIBILITY_HYSTERESIS_RESERVE_SCREEN_PX = 40;
export const PATH_CACHE_MAX_ENTRIES = 12_288;
export const PATH_CACHE_MAX_BYTES = 25 * 1_024 * 1_024;
export const DETACHED_ELEMENT_CACHE_MAX_BYTES = 25 * 1_024 * 1_024;
export const DEFAULT_CAMERA: SceneCamera = Object.freeze({ x: 0, zoom: 1 });
export const SCENE_PUBLICATION_ROOTS_PER_FRAME = 192;
// Bounds one indivisible browser publication; admission may publish further units.
export const SCENE_PUBLICATION_ELEMENTS_PER_UNIT = 16;
// Use the stricter supported profile because the scene renderer is platform-neutral.
export const DENSE_RECONCILIATION_VISIBLE_ELEMENT_THRESHOLD = 900;
