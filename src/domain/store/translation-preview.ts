import { translateElementGeometry } from "../geometry/public";
import type { InkElementV1, PointV1 } from "../schema/public";

import { resolveConnections } from "./connections";
import type { ElementStore } from "./element-store";

export function resolveConnectedTranslationPreview(
  store: ElementStore,
  targetIds: readonly string[],
  selectedIds: ReadonlySet<string>,
  delta: PointV1,
): readonly InkElementV1[] {
  const dependentIds = collectDependentIds(store, targetIds, selectedIds);
  if (dependentIds.size === 0) return Object.freeze([]);
  const translatedTargets = new Map<string, InkElementV1>();
  const lookup = (id: string) => {
    const record = store.get(id);
    if (record === undefined || !selectedIds.has(id)) return record?.element;
    const cached = translatedTargets.get(id);
    if (cached !== undefined) return cached;
    const translated = translateElementGeometry(record.element as InkElementV1, delta);
    translatedTargets.set(id, translated);
    return translated;
  };
  return Object.freeze(
    [...dependentIds].flatMap((id) => {
      const element = store.get(id)?.element;
      return element === undefined ? [] : [resolveConnections(element, lookup, "detach")];
    }),
  );
}

function collectDependentIds(
  store: ElementStore,
  targetIds: readonly string[],
  selectedIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const targetId of targetIds) {
    store.visitDependents(targetId, ({ linearId }) => {
      if (!selectedIds.has(linearId)) ids.add(linearId);
    });
  }
  return ids;
}
