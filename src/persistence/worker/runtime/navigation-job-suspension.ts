import type { DocumentRuntimeRequest } from "./types";
import type { WorkerJobQueue } from "../job-queue";
import type { WorkerJob } from "../protocol";
import { isNavigationSceneRequest } from "./request-admission";

interface NavigationSuspensionOptions {
  readonly active: () => boolean;
  readonly drain: (eligible: (job: WorkerJob<DocumentRuntimeRequest>) => boolean) => Promise<void>;
  readonly queue: WorkerJobQueue<DocumentRuntimeRequest>;
  readonly terminated: () => boolean;
}

/** Pauses one running background job while admitted navigation requests use its slot. */
export class NavigationJobSuspension {
  #pending: Promise<void> | undefined;
  #wake: (() => void) | undefined;
  #generation = 0;

  public constructor(private readonly options: NavigationSuspensionOptions) {}

  public notify(): void {
    this.#generation += 1;
    this.#wake?.();
  }

  public wait(signal: AbortSignal): Promise<void> | undefined {
    if (!this.options.active()) return undefined;
    signal.throwIfAborted();
    if (this.#pending !== undefined) return this.#pending;
    this.options.queue.suspendActive();
    this.#pending = Promise.resolve().then(() => this.run(signal));
    return this.#pending;
  }

  private async run(signal: AbortSignal): Promise<void> {
    try {
      while (this.options.active()) {
        signal.throwIfAborted();
        const generation = this.#generation;
        // Model synchronization must not mutate the suspended owner's serializer state.
        await this.options.drain(
          (job) =>
            job.payload.type === "prepare-scene-paths" && isNavigationSceneRequest(job.payload),
        );
        signal.throwIfAborted();
        if (!this.options.active()) break;
        if (generation === this.#generation) await this.waitForChange(signal);
      }
    } finally {
      this.#pending = undefined;
      if (!this.options.terminated()) this.options.queue.resumeActive();
    }
    signal.throwIfAborted();
  }

  private waitForChange(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const resume = (): void => {
        this.#wake = undefined;
        signal.removeEventListener("abort", resume);
        resolve();
      };
      this.#wake = resume;
      signal.addEventListener("abort", resume, { once: true });
      if (signal.aborted || !this.options.active()) resume();
    });
  }
}
