import { renderBandOf } from "../../domain/commands/render-bands";
import type { InkSnapshotV1 } from "../../domain/schema/public";
import type { ElementStore, StoreSliceScheduler } from "../../domain/store/public";

/** Prove bounded batch adoption without serializing trusted worker elements again. */
export async function verifyVaultUnlockIntegrity(options: {
  readonly snapshot: InkSnapshotV1;
  readonly store: ElementStore;
  readonly scheduler: StoreSliceScheduler;
}): Promise<void> {
  const { snapshot, store, scheduler } = options;
  const checkpoint = async (): Promise<void> => {
    if (scheduler.isCancelled?.()) throw new Error("Unlock integrity verification cancelled.");
    await scheduler.yieldControl();
    if (scheduler.isCancelled?.()) throw new Error("Unlock integrity verification cancelled.");
  };
  if (store.size !== snapshot.elements.length) throw divergence();
  const ranks = { content: 0, highlight: 0 };
  for (let index = 0; index < snapshot.elements.length; index += 1) {
    if (scheduler.isCancelled?.()) throw new Error("Unlock integrity verification cancelled.");
    const element = snapshot.elements[index]!;
    const band = renderBandOf(element);
    const rank = store.getRank(element.id);
    if (
      store.get(element.id)?.element !== element ||
      rank?.band !== band ||
      rank.rank !== ranks[band] ||
      (band === "highlight" && ranks.content !== 0)
    )
      throw divergence();
    ranks[band] += 1;
    if (scheduler.shouldYield()) await checkpoint();
  }
  if (scheduler.isCancelled?.()) throw new Error("Unlock integrity verification cancelled.");
}

function divergence(): Error {
  return new Error("The unlock snapshot, batches, and finalized store diverged.");
}
