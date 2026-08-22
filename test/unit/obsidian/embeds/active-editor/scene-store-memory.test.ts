import { describe, expect, it, vi } from "vitest";

import { ElementStore } from "../../../../../src/domain/store/public";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { rectangle } from "../../../domain/store/fixtures";

describe("active scene store memory source", () => {
  it("reports model and anchor bytes and releases its cache-growth listener", () => {
    const source = rectangle();
    const store = new ElementStore([source]);
    const changed = vi.fn();
    const sceneStore = new ElementSceneStore(store, changed);

    expect(sceneStore.getSnapTarget(source.id)).not.toBeNull();
    expect(sceneStore.getSnapTarget(source.id)).not.toBeNull();
    expect(changed).toHaveBeenCalledOnce();
    const usage = sceneStore.memoryUsage();
    expect(usage.anchorCacheBytes).toBeGreaterThan(0);
    expect(usage.modelBytes).toBeGreaterThan(0);

    sceneStore.release();
    store.replace(source.id, {
      ...source,
      pivot: { ...source.pivot, x: source.pivot.x + 5 },
      width: source.width + 10,
    });
    store.getSemanticAnchors(source.id);
    expect(changed).toHaveBeenCalledOnce();
  });
});
