import type { SceneElementRecord } from "./types";
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

  public constructor(
    private readonly deadline: number,
    private readonly now: () => number,
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
