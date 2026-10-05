import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import type { MutableSceneInstrumentation } from "./types";

interface SceneFrameDiagnosticState {
  readonly pendingQuery: boolean;
  readonly pendingVisibility: boolean;
  /** Received contours still reserved by the bounded remote pipeline, not all cached paths. */
  readonly readyContours: number;
  /** Prepared SVG elements awaiting publication, including retained entrants. */
  readonly readyElements: number;
  readonly waitingForPaths: boolean;
}

export interface SceneFrameDiagnosticSnapshot extends SceneFrameDiagnosticState {
  readonly frameTime: number;
  readonly startedAt: number;
  readonly deadline: number;
  readonly budgetMs: number;
  readonly remainingMsAtStart: number;
  readonly remainingMsAtEnd: number;
  readonly readyContoursAtStart: number;
  readonly readyElementsAtStart: number;
  readonly newRoots: number;
  readonly fragmentRuns: number;
  readonly mountBudgetYields: number;
  readonly mountDeadlineYields: number;
  readonly pathYields: number;
  readonly publicationYields: number;
  readonly deadlineYields: number;
  readonly deadlineExhausted: boolean;
  /** Multiple queues can stop for different reasons during one admitted frame. */
  readonly stopReasons: readonly ("publication" | "deadline" | "paths" | "pending" | "complete")[];
}

export type SceneFrameObserver = (snapshot: SceneFrameDiagnosticSnapshot) => void;

interface FrameSample {
  readonly frameTime: number;
  readonly startedAt: number;
  readonly deadline: number;
  readonly budgetMs: number;
  readonly readyContours: number;
  readonly readyElements: number;
  readonly roots: number;
  readonly fragments: number;
  readonly budgetYields: number;
  readonly deadlineYields: number;
  readonly pathBlocks: number;
  readonly publicationBlocks: number;
  readonly deadlineBlocks: number;
}

/** Optional, history-free sampling around an existing central frame admission. */
export class SceneFrameDiagnostics {
  #observer: SceneFrameObserver | undefined;

  public constructor(
    private readonly scheduler: WorkScheduler,
    private readonly instrumentation: MutableSceneInstrumentation,
    observer: SceneFrameObserver,
    private readonly readState: () => SceneFrameDiagnosticState,
  ) {
    this.#observer = observer;
  }

  public release(): void {
    this.#observer = undefined;
  }

  public begin(frameTime: number): FrameSample {
    const value = this.instrumentation;
    const prepared = this.readState();
    return {
      frameTime,
      startedAt: this.scheduler.now(),
      deadline: this.scheduler.deadline(),
      budgetMs: this.scheduler.budgetMs(),
      readyContours: prepared.readyContours,
      readyElements: prepared.readyElements,
      roots: value.domRootsPublished,
      fragments: value.domFragmentRuns,
      budgetYields: value.mountBudgetYields,
      deadlineYields: value.mountDeadlineYields,
      pathBlocks: value.visibilityPathYields,
      publicationBlocks: value.visibilityPublicationYields,
      deadlineBlocks: value.visibilityDeadlineYields,
    };
  }

  public end(sample: FrameSample): boolean {
    const observer = this.#observer;
    if (observer === undefined) return false;
    const state = this.readState();
    const value = this.instrumentation;
    const remainingMsAtEnd = sample.deadline - this.scheduler.now();
    const mountBudgetYields = value.mountBudgetYields - sample.budgetYields;
    const mountDeadlineYields = value.mountDeadlineYields - sample.deadlineYields;
    const pathYields = value.visibilityPathYields - sample.pathBlocks;
    const publicationYields = value.visibilityPublicationYields - sample.publicationBlocks;
    const deadlineYields = value.visibilityDeadlineYields - sample.deadlineBlocks;
    const stopReasons: SceneFrameDiagnosticSnapshot["stopReasons"][number][] = [];
    if (publicationYields > 0) stopReasons.push("publication");
    if (deadlineYields > 0) stopReasons.push("deadline");
    if (pathYields > 0) stopReasons.push("paths");
    if (stopReasons.length === 0)
      stopReasons.push(state.pendingVisibility || state.pendingQuery ? "pending" : "complete");
    const snapshot: SceneFrameDiagnosticSnapshot = {
      ...state,
      frameTime: sample.frameTime,
      startedAt: sample.startedAt,
      deadline: sample.deadline,
      budgetMs: sample.budgetMs,
      remainingMsAtStart: sample.deadline - sample.startedAt,
      remainingMsAtEnd,
      readyContoursAtStart: sample.readyContours,
      readyElementsAtStart: sample.readyElements,
      newRoots: value.domRootsPublished - sample.roots,
      fragmentRuns: value.domFragmentRuns - sample.fragments,
      mountBudgetYields,
      mountDeadlineYields,
      pathYields,
      publicationYields,
      deadlineYields,
      deadlineExhausted: remainingMsAtEnd <= 0,
      stopReasons,
    };
    try {
      observer(snapshot);
      return true;
    } catch {
      // Diagnostics must never interrupt the central render or future work admission.
      this.release();
      return false;
    }
  }
}
