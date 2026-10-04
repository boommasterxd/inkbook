import type { InkElementV1 } from "../../domain/schema/public";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import type { SceneContentRenderer } from "./content-renderer";
import type { SceneElementPreviews } from "./scene-element-previews";
import type { SceneContentScheduler } from "./scene-content-scheduler";
import type { SceneMotionController } from "./scene-motion-controller";
import type { PreviewTransform } from "./scene-visibility-reconciler";

interface SceneFrameWorkPorts {
  readonly backgroundPending: () => boolean;
  readonly content: SceneContentRenderer;
  readonly contentScheduler: SceneContentScheduler;
  readonly elements: SceneElementPreviews;
  readonly motion: SceneMotionController;
  readonly scheduler: WorkScheduler;
  readonly queryPending?: () => boolean;
  readonly writeBackground: (deadline: number, allowAtomic: boolean) => boolean;
}

export interface SceneFrameWorkResult {
  readonly backgroundDeferred: boolean;
  readonly pendingFades: boolean;
  readonly pendingMotion: boolean;
  readonly pendingPreview: boolean;
  readonly pendingVisibility: boolean;
  readonly waitingForPaths?: boolean;
}

/** Gives an admitted scene one bounded late unit and rotates competing queues. */
export class SceneFrameWork {
  #preferDeferred = false;
  #nextDeferredLane = 0;

  public constructor(private readonly ports: SceneFrameWorkPorts) {}

  public write(
    frameTime: number,
    deadline: number,
    transforms: ReadonlyMap<string, PreviewTransform>,
    elements: ReadonlyMap<string, InkElementV1>,
  ): SceneFrameWorkResult {
    if (this.ports.scheduler.now() >= deadline) {
      return this.writeLate(frameTime, deadline, transforms, elements);
    }
    return this.writeActive(frameTime, deadline, transforms, elements);
  }

  private writeActive(
    frameTime: number,
    deadline: number,
    transforms: ReadonlyMap<string, PreviewTransform>,
    elements: ReadonlyMap<string, InkElementV1>,
  ): SceneFrameWorkResult {
    const { content, contentScheduler, motion, scheduler } = this.ports;
    const preview = this.ports.elements.progressive;
    const now = () => scheduler.now();
    const deferredFirst = this.#preferDeferred;
    let pendingPreview = preview.pending;
    let pendingMotion = motion.pending;
    let backgroundDeferred = this.ports.backgroundPending();
    const backgroundOnly =
      backgroundDeferred &&
      !pendingPreview &&
      !pendingMotion &&
      !content.hasPendingWork &&
      this.ports.queryPending?.() !== true &&
      !content.pendingElementFades;
    let earlierWork = false;
    if (deferredFirst) {
      earlierWork = pendingPreview || pendingMotion || backgroundDeferred;
      pendingPreview = preview.write(deadline, now);
      pendingMotion = motion.write(frameTime, deadline, now);
      backgroundDeferred = this.ports.writeBackground(deadline, backgroundOnly);
    }
    const fadePending = content.pendingElementFades;
    const pendingFades = now() < deadline ? content.flushElementFades(deadline, now) : fadePending;
    earlierWork ||= fadePending;
    const contentAdmitted = now() < deadline;
    if (!contentAdmitted && !earlierWork)
      return this.writeLate(frameTime, deadline, transforms, elements);
    const pendingVisibility = contentAdmitted
      ? contentScheduler.write(deadline, transforms, elements)
      : content.hasPendingWork;
    this.#preferDeferred = pendingVisibility && !deferredFirst;
    if (!deferredFirst) {
      pendingPreview = preview.write(deadline, now);
      pendingMotion = motion.write(frameTime, deadline, now);
      // The sole pending operation may commit atomically even if bookkeeping spent the slice.
      backgroundDeferred = this.ports.writeBackground(deadline, backgroundOnly);
    }
    return {
      backgroundDeferred,
      pendingFades,
      pendingMotion,
      pendingPreview,
      pendingVisibility,
      waitingForPaths: content.waitingForPaths,
    };
  }

  private writeLate(
    frameTime: number,
    deadline: number,
    transforms: ReadonlyMap<string, PreviewTransform>,
    elements: ReadonlyMap<string, InkElementV1>,
  ): SceneFrameWorkResult {
    const { content, contentScheduler } = this.ports;
    const contentPending = content.hasPendingWork;
    const deferredPending = this.hasDeferredWork();
    let pendingVisibility = contentPending;
    if (deferredPending && (!contentPending || this.#preferDeferred)) {
      this.writeOneDeferred(frameTime, deadline);
    } else if (contentPending) {
      pendingVisibility = contentScheduler.write(deadline, transforms, elements, true);
    }
    if (contentPending && deferredPending) this.#preferDeferred = !this.#preferDeferred;
    else this.#preferDeferred = false;
    if (this.ports.backgroundPending()) this.ports.writeBackground(deadline, false);
    return {
      backgroundDeferred: this.ports.backgroundPending(),
      pendingFades: content.pendingElementFades,
      pendingMotion: this.ports.motion.pending,
      pendingPreview: this.ports.elements.progressive.pending,
      pendingVisibility,
      waitingForPaths: content.waitingForPaths,
    };
  }

  private hasDeferredWork(): boolean {
    return (
      this.ports.elements.progressive.pending ||
      this.ports.content.pendingElementFades ||
      this.ports.motion.pending ||
      this.ports.backgroundPending()
    );
  }

  private writeOneDeferred(frameTime: number, deadline: number): void {
    const { content, elements, motion, scheduler } = this.ports;
    const now = () => scheduler.now();
    for (let offset = 0; offset < 4; offset += 1) {
      const lane = (this.#nextDeferredLane + offset) % 4;
      if (lane === 0 && elements.progressive.pending) {
        elements.progressive.write(deadline, now, true);
      } else if (lane === 1 && content.pendingElementFades) {
        content.flushElementFades(deadline, now);
      } else if (lane === 2 && motion.pending) {
        motion.write(frameTime, deadline, now, true);
      } else if (
        lane === 3 &&
        this.ports.backgroundPending() &&
        this.ports.queryPending?.() !== true
      ) {
        // A validated background DOM write is indivisible once this lane is admitted.
        this.ports.writeBackground(deadline, true);
      } else continue;
      this.#nextDeferredLane = (lane + 1) % 4;
      return;
    }
  }
}
