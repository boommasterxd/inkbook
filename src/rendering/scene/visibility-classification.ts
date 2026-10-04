import type { Bounds } from "../../domain/geometry/primitives";
import type { MutableSceneInstrumentation, SceneElementRecord, SceneStorePort } from "./types";
import { intersects, sameBounds } from "./visibility-bounds";
import type { VisibilityCandidates } from "./visibility-candidates";

/** Stages exact current records without exposing partial membership to scene publication. */
export class VisibilityClassification {
  readonly records: SceneElementRecord[] = [];
  #bounds: Bounds | undefined;
  #index = 0;

  public constructor(
    private readonly store: SceneStorePort,
    private readonly instrumentation: MutableSceneInstrumentation,
  ) {}

  public collect(
    bounds: Bounds,
    candidates: VisibilityCandidates,
    deadline: number,
    now: () => number,
  ): boolean {
    if (!sameBounds(this.#bounds, bounds)) {
      this.release();
      this.#bounds = bounds;
    }
    while (this.#index < candidates.count) {
      if (now() >= deadline) return false;
      const id = candidates.ids[this.#index++];
      this.instrumentation.visibilityCandidateVisits += 1;
      const record = id === undefined ? undefined : this.store.get(id);
      if (record !== undefined && intersects(bounds, record.bounds)) this.records.push(record);
    }
    return true;
  }

  public memoryUsage(): number {
    return this.records.length * 8;
  }

  public release(): void {
    this.records.length = 0;
    this.#index = 0;
    this.#bounds = undefined;
  }
}
