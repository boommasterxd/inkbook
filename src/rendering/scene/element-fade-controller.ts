import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import type { SceneContentRenderer } from "./content-renderer";
import type { SceneDeltaCoordinator } from "./scene-delta-coordinator";
import type { SceneMotionController } from "./scene-motion-controller";
import { validateNonNegativeDuration } from "./scene-runtime";

interface FadeControllerOptions {
  readonly assertActive: () => void;
  readonly content: SceneContentRenderer;
  readonly deltas: SceneDeltaCoordinator;
  readonly motion: SceneMotionController;
  readonly scheduler: WorkScheduler;
  readonly schedule: () => void;
}

/** Owns removal-feedback admission and committed-delta suppression. */
export class SceneElementFadeController {
  public constructor(private readonly options: FadeControllerOptions) {}

  public set(ids: readonly string[], durationMs: number): void {
    this.options.assertActive();
    validateNonNegativeDuration(durationMs);
    const { content, deltas, motion, scheduler } = this.options;
    deltas.addFades(ids);
    const slice = scheduler.shouldYield()
      ? undefined
      : { deadline: scheduler.deadline(), now: () => scheduler.now() };
    content.setElementFade(ids, motion.duration(durationMs), slice);
    if (content.pendingElementFades) this.options.schedule();
  }

  public clear(ids: readonly string[]): void {
    this.options.assertActive();
    this.options.content.setElementFade(this.options.deltas.removeFades(ids), null);
  }
}

export function createFadeActions(options: FadeControllerOptions) {
  const controller = new SceneElementFadeController(options);
  return [controller.set.bind(controller), controller.clear.bind(controller)] as const;
}
