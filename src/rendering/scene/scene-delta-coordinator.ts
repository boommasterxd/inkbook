import type { SceneMotionController } from "./scene-motion-controller";
import type { ScenePreviewCommitController } from "./preview-commit-handoff";
import type { SceneCommitCoordinator } from "./scene-commit-coordinator";
import { routeSceneDeltaDomain, type SceneDeltaRoutingPorts } from "./scene-delta-router";
import type { SceneStoreDelta } from "./types";

interface SceneDeltaCoordinatorOptions {
  readonly commits: SceneCommitCoordinator;
  readonly motion: SceneMotionController;
  readonly previews: ScenePreviewCommitController;
  readonly routing: SceneDeltaRoutingPorts;
  readonly schedule: () => void;
}

export class SceneDeltaCoordinator {
  readonly #fadedIds = new Set<string>();

  public constructor(private readonly options: SceneDeltaCoordinatorOptions) {}

  public apply(delta: SceneStoreDelta): void {
    let fadedRemovals: string[] | undefined;
    for (const affected of delta.affected) {
      if (affected.after === null && this.#fadedIds.delete(affected.id)) {
        fadedRemovals ??= [];
        fadedRemovals.push(affected.id);
      }
    }
    const consumedSuppression = this.options.motion.applyDelta(delta.affected, fadedRemovals);
    for (const affected of delta.affected) {
      for (const domain of affected.domains) {
        routeSceneDeltaDomain(affected, domain, this.options.routing);
      }
    }
    this.options.previews.consume(consumedSuppression);
    this.options.commits.markPending();
    this.options.schedule();
  }

  public addFades(ids: readonly string[]): void {
    for (const id of ids) this.#fadedIds.add(id);
  }

  public removeFades(ids: readonly string[]): void {
    for (const id of ids) this.#fadedIds.delete(id);
  }

  public release(): void {
    this.#fadedIds.clear();
  }
}
