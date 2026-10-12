import type { SceneMotionController } from "./scene-motion-controller";
import type { ScenePreviewCommitController } from "./preview-commit-handoff";
import type { SceneCommitCoordinator } from "./scene-commit-coordinator";
import { routeSceneDelta, type SceneDeltaRoutingPorts } from "./scene-delta-router";
import type { SceneStoreDelta } from "./types";
import { TRANSITION_DURATIONS } from "../motion/transitions";

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

  public apply(
    delta: SceneStoreDelta,
    visibility?: { applyDelta(delta: SceneStoreDelta): void },
  ): void {
    let fadedRemovals: string[] | undefined;
    for (const affected of delta.affected) {
      const membership =
        delta.historyReplay === true &&
        ((affected.before === null && affected.after != null) ||
          (affected.before != null && affected.after === null));
      if (membership) {
        this.#fadedIds.delete(affected.id);
        this.options.routing.content.setMembershipFade(
          affected.id,
          affected.after === null ? "exit" : "enter",
          this.options.motion.duration(TRANSITION_DURATIONS.historyMembership),
          affected.after === null
            ? (affected.beforeBounds ?? undefined)
            : (affected.afterBounds ?? undefined),
        );
        fadedRemovals ??= [];
        fadedRemovals.push(affected.id);
        continue;
      }
      if (affected.after === null && this.#fadedIds.delete(affected.id)) {
        fadedRemovals ??= [];
        fadedRemovals.push(affected.id);
      }
    }
    const consumedSuppression = this.options.motion.applyDelta(delta.affected, fadedRemovals);
    routeSceneDelta(delta, this.options.routing);
    visibility?.applyDelta(delta);
    this.options.previews.consume(consumedSuppression);
    this.options.commits.markPending();
    this.options.schedule();
  }

  public addFades(ids: readonly string[]): void {
    for (const id of ids) this.#fadedIds.add(id);
  }

  public removeFades(ids: readonly string[]): readonly string[] {
    const active: string[] = [];
    for (const id of ids) {
      if (this.#fadedIds.delete(id)) active.push(id);
    }
    return active;
  }

  public release(): void {
    this.#fadedIds.clear();
  }
}
