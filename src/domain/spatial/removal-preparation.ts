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
  readonly adopt: (state: State) => void;
}

export async function prepareSpatialRemoval<Id, State>(
  stage: StagedSpatialMutation<Id>,
  ports: RemovalPreparationPorts<Id, State>,
  scheduler: SpatialReplacementPreparationScheduler,
  generation: number,
): Promise<PreparedSpatialMutation | "cancelled"> {
  let pending: State | undefined = ports.fork();
  for (const entry of stage.removed) {
    const admission = removalAdmission(ports, scheduler, generation);
    if (admission === false || (admission !== true && !(await admission))) return "cancelled";
    ports.remove(pending, entry);
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
