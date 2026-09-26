import type { MutableSceneInstrumentation, SceneElementRecord } from "./types";
import { MOUNT_SLICE_GEOMETRY_COST_BUDGET, MOUNT_SLICE_STROKE_POINT_BUDGET } from "./constants";

export interface MountCost {
  readonly geometry: number;
  readonly strokePoints: number;
}

export type MountYieldReason = "budget" | "deadline";

export class MountSlice {
  public elements = 0;
  public geometryCost = 0;
  public strokePoints = 0;
  #preparationSteps = 0;
  #publicationNodes = 0;

  public constructor(
    private readonly deadline: number,
    private readonly now: () => number,
    private readonly publicationLimit = Infinity,
  ) {}

  public blockingReason(cost: MountCost): MountYieldReason | undefined {
    if (this.elements === 0) return undefined;
    if (this.now() >= this.deadline) return "deadline";
    if (
      this.strokePoints + cost.strokePoints > MOUNT_SLICE_STROKE_POINT_BUDGET ||
      this.geometryCost + cost.geometry > MOUNT_SLICE_GEOMETRY_COST_BUDGET
    ) {
      return "budget";
    }
    return undefined;
  }

  public prepare(job: { step(deadline: number, now: () => number): boolean }): boolean {
    // Each step owns a bounded geometry unit; share the allowance across the whole slice.
    // Admission already checked the deadline; the accepted job must make one bounded step.
    let started = false;
    while (this.#preparationSteps < 64) {
      if (started && this.now() >= this.deadline) return false;
      started = true;
      this.#preparationSteps += 1;
      if (job.step(this.deadline, this.now)) return true;
    }
    return false;
  }

  public claimPublicationNodes(count: number): boolean {
    if (
      this.#publicationNodes > 0 &&
      (this.#publicationNodes + count > this.publicationLimit || this.now() >= this.deadline)
    )
      return false;
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
    instrumentation.maximumMountSliceGeometryCost = Math.max(
      instrumentation.maximumMountSliceGeometryCost,
      this.geometryCost,
    );
    instrumentation.maximumMountSliceStrokePoints = Math.max(
      instrumentation.maximumMountSliceStrokePoints,
      this.strokePoints,
    );
    if (reason === "budget") instrumentation.mountBudgetYields += 1;
    else if (reason === "deadline") instrumentation.mountDeadlineYields += 1;
  }

  public record(cost: MountCost): void {
    this.elements += 1;
    this.geometryCost += cost.geometry;
    this.strokePoints += cost.strokePoints;
  }
}

export function mountCost(record: SceneElementRecord): MountCost {
  const element = record.element;
  if (element.kind === "stroke") {
    const strokePoints = element.points.length / 3;
    return {
      geometry: strokePoints * (element.style.pressureEnabled ? 4 : 2),
      strokePoints,
    };
  }
  if (element.kind === "table") {
    return { geometry: Math.max(32, element.columns * 8), strokePoints: 0 };
  }
  if (element.kind === "coordinate-system") {
    return { geometry: Math.max(32, element.axes.length * 16), strokePoints: 0 };
  }
  return { geometry: 32, strokePoints: 0 };
}
