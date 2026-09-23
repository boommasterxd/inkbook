import type { MutableSceneInstrumentation, SceneScheduler } from "./types";

/** Owns the single pending scene/cursor frame and rejects obsolete callbacks. */
export class SceneFrameScheduler {
  #handle: number | undefined;
  #generation = 0;
  #disposed = false;
  #scenePending = false;

  public constructor(
    private readonly scheduler: SceneScheduler,
    private readonly instrumentation: MutableSceneInstrumentation,
    private readonly render: (time: number, scene: boolean) => void,
  ) {}

  public schedule(scene = true): void {
    if (this.#disposed) return;
    this.#scenePending ||= scene;
    if (this.#handle !== undefined) return;
    const generation = this.#generation;
    let handle = 0;
    handle = this.scheduler.requestAnimationFrame((time) => {
      if (this.#handle === handle) this.#handle = undefined;
      if (this.#disposed || generation !== this.#generation) {
        this.instrumentation.staleFrames += 1;
        return;
      }
      const pending = this.#scenePending;
      this.#scenePending = false;
      this.instrumentation.frames += 1;
      this.render(time, pending);
    });
    this.#handle = handle;
    this.instrumentation.scheduledFrames += 1;
  }

  public replaceGeneration(): void {
    this.#generation += 1;
    if (this.#handle !== undefined) this.scheduler.cancelAnimationFrame(this.#handle);
    this.#handle = undefined;
  }

  public dispose(): void {
    this.#disposed = true;
    this.replaceGeneration();
  }
}
