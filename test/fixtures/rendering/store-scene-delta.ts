import type { InkElementV1 } from "../../../src/domain/schema/public";
import type { StoreDelta } from "../../../src/domain/store/public";
import type { SceneStoreDelta } from "../../../src/rendering/scene/types";

/** Adapt real store publications without introducing a different mutation or rendering path. */
export function sceneStoreDelta(delta: StoreDelta): SceneStoreDelta {
  return {
    affected: delta.changes.map((change) => ({
      id: change.id,
      domains: change.domains,
      before: (change.before?.element ?? null) as InkElementV1 | null,
      after: (change.after?.element ?? null) as InkElementV1 | null,
    })),
  };
}
