import type { InkElementV1 } from "../../domain/schema/public";
import { SCENE_PUBLICATION_ROOTS_PER_FRAME } from "./constants";
import type { SceneContentRenderer } from "./content-renderer";
import type { ScenePublicationBudget } from "./mount-slice";
import type { PreviewTransform } from "./scene-visibility-reconciler";
import type { SceneScheduler } from "./types";

/** Gives each active queue the first remaining frame slice on alternating frames. */
export class SceneContentScheduler {
  #preferVisibility = false;

  public constructor(
    private readonly content: SceneContentRenderer,
    private readonly scheduler: SceneScheduler,
  ) {}

  public write(
    deadline: number,
    previewTransforms: ReadonlyMap<string, PreviewTransform>,
    previewElements: ReadonlyMap<string, InkElementV1>,
  ): boolean {
    const now = () => this.scheduler.now();
    const publication: ScenePublicationBudget = {
      remainingRoots: SCENE_PUBLICATION_ROOTS_PER_FRAME,
    };
    const reconcile = () =>
      this.content.reconcileVisibility(
        deadline,
        now,
        previewTransforms,
        previewElements,
        publication,
      );
    const writeMounted = () => this.content.writeMountedChanges(deadline, now, publication);
    if (this.#preferVisibility) {
      const visibilityPending = reconcile();
      const mountedPending = !visibilityPending || now() < deadline ? writeMounted() : true;
      this.#preferVisibility = false;
      return visibilityPending || mountedPending;
    }
    const mountedPending = writeMounted();
    const visibilityPending = !mountedPending || now() < deadline ? reconcile() : true;
    this.#preferVisibility = mountedPending;
    return mountedPending || visibilityPending;
  }
}
