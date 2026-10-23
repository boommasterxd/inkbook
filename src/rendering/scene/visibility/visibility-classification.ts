import type { Bounds } from "../../../domain/geometry/primitives";
import type { MutableSceneInstrumentation, SceneElementRecord, SceneStorePort } from "../types";
import { intersects, sameBounds } from "./visibility-bounds";
import type { VisibilityCandidates } from "./visibility-candidates";

/** Stages exact current records without exposing partial membership to scene publication. */
export class VisibilityClassification {
  readonly records: SceneElementRecord[] = [];
  readonly #acquired: SceneElementRecord[] = [];
  #bounds: Bounds | undefined;
  #index = 0;
  #classified = 0;
  #generation: number | undefined;

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
    if (this.#generation !== candidates.generation) {
      this.release();
      this.#generation = candidates.generation;
    }
    if (!sameBounds(this.#bounds, bounds)) {
      this.records.length = 0;
      this.#classified = 0;
      this.#bounds = bounds;
    }
    while (this.#index < candidates.count) {
      if (now() >= deadline) return false;
      const id = candidates.ids[this.#index++];
      this.instrumentation.visibilityCandidateVisits += 1;
      const record = id === undefined ? undefined : this.store.get(id);
      if (record === undefined) continue;
      const currentFilter = this.#classified === this.#acquired.length;
      this.#acquired.push(record);
      // Acquisition and exact filtering are one admitted record step for a fresh target.
      if (currentFilter) this.classify(record, bounds);
    }
    while (this.#classified < this.#acquired.length) {
      if (now() >= deadline) return false;
      this.classify(this.#acquired[this.#classified]!, bounds);
    }
    return true;
  }

  public memoryUsage(): number {
    return (this.records.length + this.#acquired.length) * 8;
  }

  private classify(record: SceneElementRecord, bounds: Bounds): void {
    this.#classified += 1;
    if (intersects(bounds, record.bounds)) this.records.push(record);
  }

  public release(): void {
    this.records.length = 0;
    this.#acquired.length = 0;
    this.#index = 0;
    this.#classified = 0;
    this.#generation = undefined;
    this.#bounds = undefined;
  }
}
