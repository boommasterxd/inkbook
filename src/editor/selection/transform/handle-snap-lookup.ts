import type { PointV1 } from "../../../domain/schema/public";
import { ScheduledSnapCandidate } from "../../snapping/scheduled-snap-candidate";
import type { SnapCandidate } from "../../snapping/snap-candidate";
import type { SelectionHandleAction, SelectionSnapPorts } from "../handle-types";
import { selectionSnapFeatureEnabled } from "./snap-features";

/** Owns endpoint filtering, query cancellation and exact commit settlement. */
export class HandleSnapLookup {
  readonly #lookup: ScheduledSnapCandidate | undefined;
  readonly #snap: SelectionSnapPorts | undefined;
  #active = false;

  public constructor(action: SelectionHandleAction, snap: SelectionSnapPorts | undefined) {
    this.#snap = snap;
    if (action.kind !== "linear-endpoint" || snap === undefined) return;
    this.#lookup = new ScheduledSnapCandidate(
      snap.spatial,
      {
        get: (id, bounds) =>
          id === action.elementId || !(snap.canConnect?.(action.elementId, id) ?? true)
            ? null
            : snap.targets.get(id, bounds),
      },
      snap.scheduler,
    );
  }

  public get pending(): boolean {
    return this.#lookup?.pending ?? false;
  }

  public update(
    pointer: PointV1,
    current: SnapCandidate | null,
    snap: SelectionSnapPorts | undefined,
    onReady: (candidate: SnapCandidate | null) => void,
  ): SnapCandidate | null {
    if (this.#lookup === undefined || !selectionSnapFeatureEnabled(snap, "connections")) {
      this.cancel();
      return null;
    }
    this.#active = true;
    this.#lookup.update(
      { current, pointer, pointerType: this.#snap!.pointerType, zoom: this.#snap!.zoom },
      () => onReady(this.#lookup!.value),
    );
    return this.#lookup.value;
  }

  public async settle() {
    if (!this.#active) return null;
    return (await this.#lookup?.settle()) ?? null;
  }

  public cancel(): void {
    this.#active = false;
    this.#lookup?.cancel();
  }
}
