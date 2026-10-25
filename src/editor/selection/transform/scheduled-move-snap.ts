import { rotatePointClockwise } from "../../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../../domain/schema/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import {
  ScheduledSnapCandidate,
  type ScheduledSnapResult,
} from "../../snapping/scheduled-snap-candidate";
import type {
  SnapPointerType,
  SnapTargetReader,
  SpatialCandidateQuery,
} from "../../snapping/snap-candidate";
import { moveSnapPrecedes, type SelectionMoveSnap } from "./move-snap";

interface MoveSnapOptions {
  readonly canConnect: (sourceId: string, targetId: string) => boolean;
  readonly element: InkElementV1 | undefined;
  readonly pointerType: SnapPointerType;
  readonly scheduler?: WorkScheduler;
  readonly spatial: SpatialCandidateQuery;
  readonly targets: SnapTargetReader;
}

/** One moving line owns at most its two endpoint queries. */
export class ScheduledMoveSnap {
  readonly #options: MoveSnapOptions;
  readonly #lookups = new Map<"start" | "end", ScheduledSnapCandidate>();

  public constructor(options: MoveSnapOptions) {
    this.#options = options;
    const element = options.element;
    if (element?.kind !== "line" && element?.kind !== "arrow") return;
    for (const endpoint of ["start", "end"] as const) {
      if (element[endpoint === "start" ? "startConnection" : "endConnection"] !== null) continue;
      this.#lookups.set(
        endpoint,
        new ScheduledSnapCandidate(
          options.spatial,
          {
            get: (id, bounds) =>
              id === element.id || !options.canConnect(element.id, id)
                ? null
                : options.targets.get(id, bounds),
          },
          options.scheduler,
        ),
      );
    }
  }

  public get pending(): boolean {
    return [...this.#lookups.values()].some((lookup) => lookup.pending);
  }

  public get value(): SelectionMoveSnap | null {
    if (this.pending) return null;
    return this.#choose([...this.#lookups].map(([endpoint, lookup]) => [endpoint, lookup.value]));
  }

  public update(
    delta: PointV1,
    current: SelectionMoveSnap | null,
    zoom: number,
    onReady: () => void,
  ): void {
    const element = this.#options.element;
    if (element?.kind !== "line" && element?.kind !== "arrow") return;
    for (const [endpoint, lookup] of this.#lookups) {
      const world = rotatePointClockwise(element[endpoint], element.pivot, element.rotation);
      lookup.update(
        {
          current: current?.endpoint === endpoint ? current.candidate : null,
          pointer: { x: world.x + delta.x, y: world.y + delta.y },
          pointerType: this.#options.pointerType,
          zoom,
        },
        onReady,
      );
    }
  }

  public async settle(): Promise<SelectionMoveSnap | null | "cancelled"> {
    const results = await Promise.all(
      [...this.#lookups].map(
        async ([endpoint, lookup]) => [endpoint, await lookup.settle()] as const,
      ),
    );
    if (results.some(([, candidate]) => candidate === "cancelled")) return "cancelled";
    return this.#choose(results);
  }

  public cancel(): void {
    for (const lookup of this.#lookups.values()) lookup.cancel();
  }

  #choose(
    results: readonly (readonly ["start" | "end", ScheduledSnapResult])[],
  ): SelectionMoveSnap | null {
    const element = this.#options.element;
    if (element?.kind !== "line" && element?.kind !== "arrow") return null;
    let best: SelectionMoveSnap | null = null;
    for (const [endpoint, candidate] of results) {
      if (candidate === null || candidate === "cancelled") continue;
      const world = rotatePointClockwise(element[endpoint], element.pivot, element.rotation);
      const snap = {
        candidate,
        delta: { x: candidate.point.x - world.x, y: candidate.point.y - world.y },
        elementId: element.id,
        endpoint,
      };
      if (best === null || moveSnapPrecedes(snap, best)) best = snap;
    }
    return best;
  }
}
