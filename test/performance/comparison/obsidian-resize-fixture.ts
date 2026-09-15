import type { ComparisonImplementation } from "./contracts";
export const OBSIDIAN_RESIZE_MODULES = [
  "domain/geometry/public",
  "editor/selection/public",
  "domain/store/public",
  "obsidian/embeds/active-editor/handle-interaction",
  "obsidian/embeds/active-editor/history",
  "obsidian/embeds/active-editor/move-preview",
  "obsidian/embeds/active-editor/scene-store",
  "rendering/scene/index",
] as const;
export function resizeApi(impl: ComparisonImplementation) {
  return {
    ...impl.get<typeof import("../../../src/domain/geometry/public")>("domain/geometry/public"),
    ...impl.get<typeof import("../../../src/editor/selection/public")>("editor/selection/public"),
    ...impl.get<typeof import("../../../src/domain/store/public")>("domain/store/public"),
    ...impl.get<typeof import("../../../src/obsidian/embeds/active-editor/handle-interaction")>(
      "obsidian/embeds/active-editor/handle-interaction",
    ),
    ...impl.get<typeof import("../../../src/obsidian/embeds/active-editor/history")>(
      "obsidian/embeds/active-editor/history",
    ),
    ...impl.get<typeof import("../../../src/obsidian/embeds/active-editor/move-preview")>(
      "obsidian/embeds/active-editor/move-preview",
    ),
    ...impl.get<typeof import("../../../src/obsidian/embeds/active-editor/scene-store")>(
      "obsidian/embeds/active-editor/scene-store",
    ),
    ...impl.get<typeof import("../../../src/rendering/scene/index")>("rendering/scene/index"),
  };
}
