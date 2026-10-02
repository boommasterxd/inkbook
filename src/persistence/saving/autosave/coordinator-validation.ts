import type { AutosaveCoordinatorOptions } from "./types";

export function assertAutosaveInitialState(options: AutosaveCoordinatorOptions): void {
  if (options.initialSnapshot.revision !== options.documentSource.currentRevision()) {
    throw new RangeError("Initial snapshot and document revision must match.");
  }
  if (
    options.confirmedBase.type === "confirmed" &&
    options.confirmedBase.revision !== options.initialSnapshot.revision
  ) {
    throw new RangeError("Confirmed base and initial snapshot revision must match.");
  }
}
