import type { SceneGeometryPublication } from "../content/geometry-publication";
import type { SceneSelectionRuns } from "./selection-runs";

/** Advances existing feedback publication before the complete immediate input writer. */
export class RunTranslationAdmission {
  public constructor(
    private readonly runs: SceneSelectionRuns,
    private readonly publication: SceneGeometryPublication,
  ) {}

  public readonly prepare: SceneSelectionRuns["prepareTranslation"] = (
    request,
    published,
    deadline,
    now,
    budget,
  ) => {
    const staged = this.runs.stageTranslation(request, published);
    if (!staged && !this.runs.committing) return false;
    // Preserve the ordinary trace-first policy and its shared DOM-publication allowance.
    this.publication.writeMountedChanges(deadline, now, budget);
    return this.runs.prepareTranslation(request, published, deadline, now, budget);
  };
}
