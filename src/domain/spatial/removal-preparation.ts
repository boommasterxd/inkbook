import type { IndexedEntry } from "./index-state";
import {
  spatialMutationCheckpoint,
  type PreparedSpatialMutation,
  type StagedSpatialMutation,
} from "./mutation-preparation";
import type { SpatialReplacementPreparationScheduler } from "./replacement-preparation";

interface RemovalPreparationPorts<Id, State> {
  readonly generation: () => number;
  readonly fork: () => State;
  readonly remove: (state: State, entry: IndexedEntry<Id>) => void;
  readonly overflowMaximum: number | undefined;
  readonly overflowSlots: (state: State) => Iterable<number>;
  readonly overflowBottom: (state: State, slot: number) => number | undefined;
  readonly setOverflowMaximum: (state: State, maximum: number | undefined) => void;
  readonly adopt: (state: State) => void;
}

export async function prepareSpatialRemoval<Id, State>(
  stage: StagedSpatialMutation<Id>,
  ports: RemovalPreparationPorts<Id, State>,
  scheduler: SpatialReplacementPreparationScheduler,
  generation: number,
): Promise<PreparedSpatialMutation | "cancelled"> {
  let pending: State | undefined = ports.fork();
  let removedMaximum = false;
  for (const entry of stage.removed) {
    const admission = removalAdmission(ports, scheduler, generation);
    if (admission === false || (admission !== true && !(await admission))) return "cancelled";
    ports.remove(pending, entry);
    removedMaximum ||= entry.overflow && entry.maxY === ports.overflowMaximum;
  }
  if (removedMaximum) {
    // Repair the private maximum once, with the same admission and generation guards as removal.
    let maximum: number | undefined;
    for (const slot of ports.overflowSlots(pending)) {
      const admission = removalAdmission(ports, scheduler, generation);
      if (admission === false || (admission !== true && !(await admission))) return "cancelled";
      const bottom = ports.overflowBottom(pending, slot);
      if (bottom !== undefined) maximum = Math.max(maximum ?? -Infinity, bottom);
    }
    ports.setOverflowMaximum(pending, maximum);
  }
  const admission = removalAdmission(ports, scheduler, generation);
  if (admission === false || (admission !== true && !(await admission))) return "cancelled";
  return stage.commitWith(() => {
    const ready = pending!;
    pending = undefined;
    ports.adopt(ready);
  });
}

function removalAdmission<Id, State>(
  ports: RemovalPreparationPorts<Id, State>,
  scheduler: SpatialReplacementPreparationScheduler,
  generation: number,
): boolean | Promise<boolean> {
  const admission = spatialMutationCheckpoint(scheduler);
  return typeof admission === "boolean"
    ? admission && generation === ports.generation()
    : admission.then((allowed) => allowed && generation === ports.generation());
}
