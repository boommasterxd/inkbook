import type { MutableSceneInstrumentation } from "./types";

/** Shared allowance for new live SVG roots in one scene frame. */
export interface ScenePublicationBudget {
  remainingRoots: number;
}

export type MountYieldReason = "budget" | "deadline" | "paths";

export class MountSlice {
  public elements = 0;
  #publicationNodes = 0;

  public get publicationNodes(): number {
    return this.#publicationNodes;
  }

  public get canPublish(): boolean {
    return this.#publicationNodes < this.publicationLimit;
  }

  public constructor(
    private readonly deadline: number,
    private readonly now: () => number,
    private readonly publicationLimit = Infinity,
  ) {}

  public blockingReason(): MountYieldReason | undefined {
    if (this.elements === 0) return undefined;
    if (this.now() >= this.deadline) return "deadline";
    return undefined;
  }

  public prepare(job: { step(deadline: number, now: () => number): boolean }): boolean {
    // The admitted job makes one bounded step, then the shared deadline controls continuation.
    let started = false;
    while (true) {
      if (started && this.now() >= this.deadline) return false;
      started = true;
      if (job.step(this.deadline, this.now)) return true;
    }
  }

  public claimPublicationNodes(count: number): boolean {
    if (count <= 0 || this.#publicationNodes + count > this.publicationLimit) return false;
    if (this.#publicationNodes > 0 && this.now() >= this.deadline) return false;
    this.#publicationNodes += count;
    return true;
  }

  public report(
    instrumentation: MutableSceneInstrumentation,
    reason: MountYieldReason | undefined,
  ): void {
    if (this.elements === 0) return;
    instrumentation.mountSlices += 1;
    instrumentation.maximumMountSliceElements = Math.max(
      instrumentation.maximumMountSliceElements,
      this.elements,
    );
    if (reason === "budget") instrumentation.mountBudgetYields += 1;
    else if (reason === "deadline") instrumentation.mountDeadlineYields += 1;
  }

  public record(): void {
    this.elements += 1;
  }
}
