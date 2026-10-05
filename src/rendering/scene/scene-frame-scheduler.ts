import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import type { MutableSceneInstrumentation } from "./types";
import { SceneFrameDiagnostics, type SceneFrameObserver } from "./scene-frame-diagnostics";

/** Owns the single pending scene/cursor frame and rejects obsolete callbacks. */
export class SceneFrameScheduler {
  #handle: number | undefined;
  #generation = 0;
  #disposed = false;
  #scenePending = false;
  #diagnostics: SceneFrameDiagnostics | undefined;

  public constructor(
    private readonly scheduler: WorkScheduler,
    private readonly instrumentation: MutableSceneInstrumentation,
    private readonly render: (time: number, scene: boolean) => void,
  ) {}

  public observeFrames(
    observer: SceneFrameObserver | undefined,
    readState: ConstructorParameters<typeof SceneFrameDiagnostics>[3],
  ): void {
    this.#diagnostics?.release();
    this.#diagnostics =
      observer === undefined || this.#disposed
        ? undefined
        : new SceneFrameDiagnostics(this.scheduler, this.instrumentation, observer, readState);
  }

  public readonly schedule = (scene = true): void => {
    if (this.#disposed) return;
    this.#scenePending ||= scene;
    if (this.#handle !== undefined) return;
    const generation = this.#generation;
    let handle = 0;
    handle = this.scheduler.requestFrame((time) => {
      if (this.#handle === handle) this.#handle = undefined;
      if (this.#disposed || generation !== this.#generation) {
        this.instrumentation.staleFrames += 1;
        return;
      }
      const pending = this.#scenePending;
      this.#scenePending = false;
      this.instrumentation.frames += 1;
      const diagnostics = pending ? this.#diagnostics : undefined;
      const sample = diagnostics?.begin(time);
      this.render(time, pending);
      if (
        sample !== undefined &&
        diagnostics?.end(sample) === false &&
        this.#diagnostics === diagnostics
      )
        this.#diagnostics = undefined;
    });
    this.#handle = handle;
    this.instrumentation.scheduledFrames += 1;
  };

  public replaceGeneration(): void {
    this.#generation += 1;
    if (this.#handle !== undefined) this.scheduler.cancelFrame(this.#handle);
    this.#handle = undefined;
  }

  public dispose(): void {
    this.#disposed = true;
    this.#diagnostics?.release();
    this.#diagnostics = undefined;
    this.replaceGeneration();
  }
}
