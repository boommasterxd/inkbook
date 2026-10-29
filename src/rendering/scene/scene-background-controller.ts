import type { PageV1 } from "../../domain/schema/public";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { SceneBackgroundCache } from "./content/background-cache";
import type { SceneFrameWriter } from "./scene-frame-writer";
import type { MutableSceneInstrumentation } from "./types";

/** Owns presentation-only background coverage independently of viewport layout. */
export class SceneBackgroundController {
  public readonly cache = new SceneBackgroundCache();
  public dirty = true;
  #page: PageV1;
  #pageHeight = 1;
  #minimumBlockSize = 0;

  public constructor(
    page: PageV1,
    private readonly scheduler: WorkScheduler,
    private readonly instrumentation: MutableSceneInstrumentation,
  ) {
    this.#page = page;
  }

  public setPage(page: PageV1, height = this.#pageHeight): boolean {
    if (!Number.isFinite(height) || height <= 0)
      throw new RangeError("Page height must be finite and positive.");
    if (page === this.#page && height === this.#pageHeight) return false;
    this.#page = page;
    this.#pageHeight = height;
    this.dirty = true;
    return true;
  }

  public setMinimumBlockSize(value: number): boolean {
    if (!Number.isFinite(value) || value < 0)
      throw new RangeError("Minimum background block size must be finite and non-negative.");
    if (value === this.#minimumBlockSize) return false;
    this.#minimumBlockSize = value;
    this.dirty = true;
    return true;
  }

  public invalidateZoom(): boolean {
    this.dirty = true;
    return this.#minimumBlockSize > 0;
  }

  public write(
    writer: SceneFrameWriter,
    zoom: number,
    deadline: number,
    allowAtomic: boolean,
  ): boolean {
    if (!this.dirty) return false;
    if (!allowAtomic && this.scheduler.now() >= deadline) {
      this.instrumentation.backgroundBudgetDeferrals += 1;
      return true;
    }
    writer.writeBackground(
      this.#page,
      Math.max(this.#pageHeight, this.#minimumBlockSize / zoom),
      zoom,
    );
    this.dirty = false;
    return false;
  }
}
