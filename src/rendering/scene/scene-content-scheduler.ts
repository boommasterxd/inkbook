import type { InkElementV1 } from "../../domain/schema/public";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { SCENE_PUBLICATION_ROOTS_PER_FRAME } from "./constants";
import type { SceneContentRenderer } from "./content-renderer";
import type { ScenePublicationBudget } from "./reconciliation/mount-slice";
import type { PreviewTransform } from "./reconciliation/scene-visibility-reconciler";

/** Retires obsolete DOM first; otherwise alternates the first remaining frame slice. */
export class SceneContentScheduler {
  #preferVisibility = false;

  public constructor(
    private readonly content: SceneContentRenderer,
    private readonly scheduler: WorkScheduler,
  ) {}

  public write(
    deadline: number,
    previewTransforms: ReadonlyMap<string, PreviewTransform>,
    previewElements: ReadonlyMap<string, InkElementV1>,
    allowLatePreparedUnit = false,
  ): boolean {
    const now = () => this.scheduler.now();
    const publication: ScenePublicationBudget = {
      allowLatePreparedUnit,
      remainingRoots: SCENE_PUBLICATION_ROOTS_PER_FRAME,
    };
    const reconcile = () =>
      this.content.deferVisibilityForRunCommit
        ? this.content.hasVisibilityWork
        : this.content.reconcileVisibility(
            deadline,
            now,
            previewTransforms,
            previewElements,
            publication,
          );
    const writeMounted = () => {
      const admittedFirstStep = publication.allowLatePreparedUnit === true;
      publication.allowLatePreparedUnit = false;
      return this.content.writeMountedChanges(deadline, now, publication, admittedFirstStep);
    };
    if (this.content.deferVisibilityForRunCommit) {
      const mountedPending = writeMounted();
      return mountedPending || this.content.hasVisibilityWork;
    }
    if (
      this.#preferVisibility ||
      !this.content.hasMountedWork ||
      (this.content.hasPendingExitCleanup && this.content.hasGeometryWork)
    ) {
      const visibilityPending = this.content.hasVisibilityWork ? reconcile() : false;
      const mountedPending = now() < deadline ? writeMounted() : this.content.hasMountedWork;
      this.#preferVisibility = false;
      return visibilityPending || mountedPending;
    }
    const mountedPending = writeMounted();
    const canRunVisibility = now() < deadline;
    const visibilityPending = canRunVisibility ? reconcile() : this.content.hasVisibilityWork;
    this.#preferVisibility = mountedPending || (!canRunVisibility && visibilityPending);
    return mountedPending || visibilityPending;
  }
}
