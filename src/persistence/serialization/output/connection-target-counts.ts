import { connectionReferences } from "../../../domain/store/records/connections";
import type { InkElementV1 } from "../../../domain/schema/public";

/** Counts are owned by the same validated model as its canonical element records. */
export function updateConnectionTargetCounts(
  counts: Map<string, number>,
  element: InkElementV1,
  sign: 1 | -1,
): void {
  for (const { targetId } of connectionReferences(element)) {
    const count = (counts.get(targetId) ?? 0) + sign;
    if (count === 0) counts.delete(targetId);
    else counts.set(targetId, count);
  }
}

/** Reuse unchanged counts; otherwise stage a complete index under scheduler control. */
export function* prepareConnectionTargetCounts(
  current: Map<string, number>,
  elements: ReadonlyMap<string, InkElementV1>,
  changed: ReadonlyMap<string, InkElementV1>,
  removed: ReadonlySet<string>,
  nodesPerStep: number,
): Generator<void, Map<string, number>> {
  const changes = yield* prepareConnectionTargetCountChanges(
    current,
    elements,
    changed,
    removed,
    nodesPerStep,
  );
  let different = false;
  let visited = 0;
  for (const [id, count] of changes) {
    if ((current.get(id) ?? 0) !== count) different = true;
    if (++visited % nodesPerStep === 0) yield;
  }
  if (!different) return current;
  const next = new Map<string, number>();
  for (const [id, count] of current) {
    next.set(id, count);
    if (++visited % nodesPerStep === 0) yield;
  }
  for (const [id, count] of changes) {
    if (count === 0) next.delete(id);
    else next.set(id, count);
    if (++visited % nodesPerStep === 0) yield;
  }
  return next;
}

/** Detached changes leave the current model untouched across scheduler checkpoints. */
function* prepareConnectionTargetCountChanges(
  current: ReadonlyMap<string, number>,
  elements: ReadonlyMap<string, InkElementV1>,
  changed: ReadonlyMap<string, InkElementV1>,
  removed: ReadonlySet<string>,
  nodesPerStep: number,
): Generator<void, ReadonlyMap<string, number>> {
  const changes = new Map<string, number>();
  const include = (element: InkElementV1, sign: 1 | -1) => {
    for (const { targetId } of connectionReferences(element)) {
      changes.set(targetId, (changes.get(targetId) ?? current.get(targetId) ?? 0) + sign);
    }
  };
  let visited = 0;
  for (const id of removed) {
    const previous = elements.get(id);
    if (previous !== undefined) include(previous, -1);
    if (++visited % nodesPerStep === 0) yield;
  }
  for (const [id, element] of changed) {
    const previous = elements.get(id);
    if (previous !== undefined) include(previous, -1);
    include(element, 1);
    if (++visited % nodesPerStep === 0) yield;
  }
  return changes;
}
