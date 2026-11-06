import type { PointV1 } from "../../../../domain/schema/public";
import type { WorkScheduler } from "../../../../domain/scheduling/work-scheduler";
import type { GesturePreviewStart } from "../../../../editor/gestures/public";
import type {
  SnapCandidate,
  SnapTargetReader,
  SpatialCandidateQuery,
} from "../../../../editor/snapping/snap-candidate";
import { ScheduledSnapCandidate } from "../../../../editor/snapping/scheduled-snap-candidate";

export interface CreationSnapPorts {
  readonly angles?: boolean | (() => boolean);
  readonly connections?: boolean | (() => boolean);
  readonly pageToScreen: (point: PointV1) => PointV1;
  readonly spatial: SpatialCandidateQuery;
  readonly targets: SnapTargetReader;
  readonly zoom: number;
}

interface CreationSnappingOptions {
  readonly snap: CreationSnapPorts;
  readonly scheduler?: WorkScheduler;
  readonly start: GesturePreviewStart["pointer"];
  readonly readRevision: () => number;
  readonly isCurrent: () => boolean;
  readonly onReady: () => void;
}

/** Fixed-start and moving-end lookup share the initial query and own their continuations. */
export class CreationSnapping {
  readonly #options: CreationSnappingOptions;
  readonly #startLookup: ScheduledSnapCandidate;
  readonly #endLookup: ScheduledSnapCandidate;
  #startResolved = false;
  #endSharesStart = true;
  #enabled = false;
  #revision = 0;
  #pointer: GesturePreviewStart["pointer"];
  #origin: PointV1;
  #endEnabled = true;
  public start: SnapCandidate | null = null;
  public end: SnapCandidate | null = null;

  public constructor(options: CreationSnappingOptions) {
    this.#options = options;
    this.#pointer = options.start;
    this.#origin = options.start;
    this.#startLookup = new ScheduledSnapCandidate(
      options.snap.spatial,
      options.snap.targets,
      options.scheduler,
    );
    this.#endLookup = new ScheduledSnapCandidate(
      options.snap.spatial,
      options.snap.targets,
      options.scheduler,
    );
  }

  public get pending(): boolean {
    return this.#startLookup.pending || this.#endLookup.pending;
  }

  public get needsRevalidation(): boolean {
    return this.#revision !== this.#options.readRevision();
  }

  public update(
    pointer: GesturePreviewStart["pointer"],
    enabled: boolean,
    revalidate = false,
    endpoints?: { readonly start: PointV1; readonly endEnabled: boolean },
  ): void {
    revalidate ||= this.needsRevalidation;
    const origin = endpoints?.start ?? this.#options.start;
    if (origin.x !== this.#origin.x || origin.y !== this.#origin.y) {
      this.#startResolved = false;
      this.start = null;
      this.end = null;
      this.cancel();
    }
    this.#origin = origin;
    this.#endEnabled = endpoints?.endEnabled ?? true;
    this.#pointer = pointer;
    this.#enabled = enabled;
    this.#revision = this.#options.readRevision();
    if (!enabled) {
      this.start = null;
      this.end = null;
      this.#startResolved = false;
      this.cancel();
      return;
    }
    const { snap } = this.#options;
    const start = { ...origin, pointerType: this.#options.start.pointerType };
    if (endpoints !== undefined) this.#endSharesStart = true;
    if (pointer.x !== start.x || pointer.y !== start.y) this.#endSharesStart = false;
    const ready = () => {
      this.#sync();
      this.#options.onReady();
    };
    if (!this.#startResolved || revalidate) {
      this.#startLookup.update(
        {
          current: revalidate ? this.start : null,
          pointer: start,
          pointerType: start.pointerType,
          zoom: snap.zoom,
        },
        ready,
      );
      this.#startResolved = true;
    }
    if (this.#endEnabled && !this.#endSharesStart) {
      this.#endLookup.update(
        { current: this.end, pointer, pointerType: start.pointerType, zoom: snap.zoom },
        ready,
      );
    } else this.#endLookup.cancel();
    this.#sync();
  }

  public async settle(): Promise<boolean> {
    while (this.#options.isCurrent()) {
      const revision = this.#revision;
      const [start, end] = await Promise.all([
        this.#startLookup.settle(),
        (this.#endSharesStart ? this.#startLookup : this.#endLookup).settle(),
      ]);
      if (!this.#options.isCurrent()) return false;
      if (revision !== this.#options.readRevision()) {
        this.update(this.#pointer, this.#enabled, true, {
          start: this.#origin,
          endEnabled: this.#endEnabled,
        });
        continue;
      }
      if (start === "cancelled" || end === "cancelled") return false;
      this.start = start;
      this.end = this.#endEnabled ? end : null;
      return true;
    }
    return false;
  }

  public cancel(): void {
    this.#startLookup.cancel();
    this.#endLookup.cancel();
  }

  #sync(): void {
    this.start = this.#startLookup.value;
    this.end = !this.#endEnabled ? null : this.#endSharesStart ? this.start : this.#endLookup.value;
  }
}
