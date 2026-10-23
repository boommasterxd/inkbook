/** Advances a dirty queue by at least one item, then observes the shared deadline. */
export function writeDirtySet(
  dirty: Set<string>,
  deadline: number,
  now: () => number,
  write: (id: string) => void | boolean,
): boolean {
  let processed = 0;
  for (const id of dirty) {
    if (processed > 0 && now() >= deadline) return true;
    if (write(id) === false) return true;
    dirty.delete(id);
    processed += 1;
  }
  return false;
}
import type { RenderBand } from "../../../domain/commands/render-bands";
import type { SceneStorePort } from "../types";
import type { DetachedSceneElementCache } from "./detached-element-cache";

export function markSceneOrderDirty(
  id: string,
  store: SceneStorePort,
  dirty: Record<RenderBand, Set<string>>,
  retained?: DetachedSceneElementCache,
): void {
  retained?.invalidateRanks();
  retained?.invalidate(id);
  retained?.unregisterMounted(id);
  const record = store.get(id);
  if (record === undefined) {
    dirty.content.add(id);
    dirty.highlight.add(id);
  } else dirty[record.band].add(id);
}
