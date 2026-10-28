import { unionBounds, type Bounds } from "../../../domain/geometry/primitives";
import type { MutableSceneInstrumentation, SceneElementRecord, SceneStorePort } from "../types";
import {
  cellRange,
  envelopeFringes,
  envelopesOverlap,
  intersects,
  sameBounds,
} from "./visibility-bounds";

interface EdgeChanges {
  readonly entered: readonly SceneElementRecord[];
  readonly exited: readonly string[];
}

export type EdgeProgress = EdgeChanges | "pending";

interface ClassificationProof {
  readonly minXLower: number;
  readonly minXUpper: number;
  readonly minYLower: number;
  readonly minYUpper: number;
  readonly maxXLower: number;
  readonly maxXUpper: number;
  readonly maxYLower: number;
  readonly maxYUpper: number;
  readonly entered: number;
  readonly exited: number;
}

const EMPTY_PROOF: ClassificationProof = Object.freeze({
  minXLower: -Infinity,
  minXUpper: Infinity,
  minYLower: -Infinity,
  minYUpper: Infinity,
  maxXLower: -Infinity,
  maxXUpper: Infinity,
  maxYLower: -Infinity,
  maxYUpper: Infinity,
  entered: 0,
  exited: 0,
});

/** Reuses one deduplicated fringe buffer across overlapping camera movements. */
export class VisibilityEdgeQuery {
  readonly #ids: string[] = [];
  readonly #records: (SceneElementRecord | undefined)[] = [];
  readonly #seen = new Set<string>();
  readonly #entered: SceneElementRecord[] = [];
  readonly #exited: string[] = [];
  readonly #fringes: Bounds[] = [];
  readonly #proofs: ClassificationProof[] = [];
  #queryCursor = 0;
  #cursor = 0;
  #unstableStart = 0;
  #current: Bounds | undefined;
  #previous: Bounds | undefined;
  #spatialCursor: ReturnType<NonNullable<SceneStorePort["beginQuery"]>> | undefined;

  public constructor(
    private readonly store: SceneStorePort,
    private readonly instrumentation: MutableSceneInstrumentation,
  ) {}

  public collect(
    previous: Bounds,
    current: Bounds,
    wasVisible: (id: string) => boolean,
    deadline: number,
    now: () => number,
  ): EdgeProgress {
    this.retarget(previous, current);
    const sink = {
      add: (id: string): void => {
        if (this.#seen.has(id)) return;
        this.#seen.add(id);
        this.#ids.push(id);
      },
    };
    while (this.#queryCursor < this.#fringes.length) {
      if (now() >= deadline) return "pending";
      if (this.store.beginQuery === undefined) {
        this.store.query(this.#fringes[this.#queryCursor++]!, sink);
        this.instrumentation.spatialQueries += 1;
        continue;
      }
      if (this.#spatialCursor === undefined) {
        this.#spatialCursor = this.store.beginQuery(this.#fringes[this.#queryCursor]!);
        this.instrumentation.spatialQueries += 1;
      }
      // One indexed visit is indivisible; the owning frame deadline admits all further work.
      const step = this.#spatialCursor.advance(1);
      if (step.stale) {
        this.release();
        return "pending";
      }
      for (const id of step.ids) sink.add(id);
      if (step.done) {
        this.#spatialCursor = undefined;
        this.#queryCursor += 1;
      }
    }
    while (this.#cursor < this.#ids.length) {
      if (now() >= deadline) return "pending";
      const id = this.#ids[this.#cursor++]!;
      this.instrumentation.visibilityCandidateVisits += 1;
      this.#records.push(this.store.get(id));
      this.#unstableStart = this.#records.length;
    }
    while (this.#proofs.length < this.#ids.length) {
      if (now() >= deadline) return "pending";
      this.classifyCurrent(current, wasVisible);
    }
    return { entered: this.#entered, exited: this.#exited };
  }

  private classifyCurrent(current: Bounds, wasVisible: (id: string) => boolean): void {
    const index = this.#proofs.length;
    const id = this.#ids[index]!;
    const record = this.#records[index];
    const bounds = record?.bounds;
    const visible = bounds !== undefined && intersects(current, bounds);
    if (visible !== wasVisible(id)) {
      if (visible && record !== undefined) this.#entered.push(record);
      else this.#exited.push(id);
    }
    this.#proofs.push(
      classificationProof(
        this.#proofs[index - 1] ?? EMPTY_PROOF,
        current,
        bounds,
        this.#entered.length,
        this.#exited.length,
      ),
    );
  }

  private retarget(previous: Bounds, current: Bounds): void {
    if (sameBounds(this.#current, current) && sameBounds(this.#previous, previous)) return;
    const reusableCells = this.store.beginQuery !== undefined && sameExtent(previous, current);
    const compatible =
      reusableCells &&
      sameBounds(this.#previous, previous) &&
      this.#current !== undefined &&
      sameExtent(this.#current, current) &&
      envelopesOverlap(previous, current);
    if (!compatible) this.release();
    else this.retainClassification(current);
    this.#previous = previous;
    this.#current = current;
    for (const fringe of [
      ...envelopeFringes(previous, current),
      ...envelopeFringes(current, previous),
    ]) {
      // Cell-aligned acquisition preserves candidates needed by a later exact target.
      // Equal-size overlapping targets span at most three envelope extents per axis.
      this.addUncovered(reusableCells ? cellRange(fringe).bounds : fringe);
    }
  }

  private retainClassification(current: Bounds): void {
    let valid = 0;
    let upper = this.#proofs.length;
    while (valid < upper) {
      const middle = Math.ceil((valid + upper) / 2);
      if (proofAccepts(this.#proofs[middle - 1]!, current)) valid = middle;
      else upper = middle - 1;
    }
    if (valid === this.#proofs.length) return;
    const proof = this.#proofs[valid - 1] ?? EMPTY_PROOF;
    this.#entered.length = proof.entered;
    this.#exited.length = proof.exited;
    this.#proofs.length = valid;
    // Each newly unstable candidate joins the tail; known unstable candidates stay there.
    if (valid >= this.#unstableStart) return;
    const tail = --this.#unstableStart;
    [this.#records[valid], this.#records[tail]] = [this.#records[tail], this.#records[valid]];
    [this.#ids[valid], this.#ids[tail]] = [this.#ids[tail]!, this.#ids[valid]!];
  }

  private addUncovered(bounds: Bounds): void {
    let uncovered = [bounds];
    for (const covered of this.#fringes) {
      uncovered = uncovered
        .flatMap((region) =>
          intersects(region, covered) ? envelopeFringes(region, covered) : [region],
        )
        .filter((region) => region.minX < region.maxX && region.minY < region.maxY);
      if (uncovered.length === 0) return;
    }
    for (const region of uncovered) this.addRegion(region);
  }

  private addRegion(bounds: Bounds): void {
    const firstPending = this.#queryCursor + (this.#spatialCursor === undefined ? 0 : 1);
    for (let index = firstPending; index < this.#fringes.length; index += 1) {
      const pending = this.#fringes[index]!;
      if (this.store.beginQuery === undefined || !canMergeRegions(pending, bounds)) continue;
      bounds = unionBounds(pending, bounds);
      this.#fringes.splice(index, 1);
      index = firstPending - 1;
    }
    this.#fringes.push(bounds);
  }

  public release(): void {
    this.#spatialCursor?.cancel();
    this.#spatialCursor = undefined;
    this.#ids.length = 0;
    this.#records.length = 0;
    this.#seen.clear();
    this.#entered.length = 0;
    this.#exited.length = 0;
    this.#fringes.length = 0;
    this.#proofs.length = 0;
    this.#queryCursor = 0;
    this.#cursor = 0;
    this.#unstableStart = 0;
    this.#current = undefined;
    this.#previous = undefined;
  }

  public get pending(): boolean {
    return (
      this.#current !== undefined &&
      (this.#queryCursor < this.#fringes.length ||
        this.#cursor < this.#ids.length ||
        this.#proofs.length < this.#ids.length)
    );
  }

  public memoryUsage(): number {
    return (
      this.#ids.length * 16 +
      this.#records.length * 8 +
      this.#fringes.length * 32 +
      this.#proofs.length * 80 +
      this.#seen.size * 32 +
      this.#entered.length * 8 +
      this.#exited.length * 16 +
      (this.#spatialCursor?.memoryUsage?.() ?? 0)
    );
  }
}

function sameExtent(left: Bounds, right: Bounds): boolean {
  return (
    left.maxX - left.minX === right.maxX - right.minX &&
    left.maxY - left.minY === right.maxY - right.minY
  );
}

function canMergeRegions(left: Bounds, right: Bounds): boolean {
  return (
    intersects(left, right) &&
    ((left.minX === right.minX && left.maxX === right.maxX) ||
      (left.minY === right.minY && left.maxY === right.maxY))
  );
}

function proofAccepts(proof: ClassificationProof, bounds: Bounds): boolean {
  return (
    bounds.minX > proof.minXLower &&
    bounds.minX <= proof.minXUpper &&
    bounds.minY > proof.minYLower &&
    bounds.minY <= proof.minYUpper &&
    bounds.maxX >= proof.maxXLower &&
    bounds.maxX < proof.maxXUpper &&
    bounds.maxY >= proof.maxYLower &&
    bounds.maxY < proof.maxYUpper
  );
}

/** Nested prefix constraints prove previous classifications without visiting those records. */
function classificationProof(
  previous: ClassificationProof,
  current: Bounds,
  bounds: Bounds | undefined,
  entered: number,
  exited: number,
): ClassificationProof {
  const next = { ...previous, entered, exited };
  if (bounds === undefined) return next;
  if (current.maxX < bounds.minX) next.maxXUpper = Math.min(next.maxXUpper, bounds.minX);
  else if (current.minX > bounds.maxX) next.minXLower = Math.max(next.minXLower, bounds.maxX);
  else if (current.maxY < bounds.minY) next.maxYUpper = Math.min(next.maxYUpper, bounds.minY);
  else if (current.minY > bounds.maxY) next.minYLower = Math.max(next.minYLower, bounds.maxY);
  else {
    next.minXUpper = Math.min(next.minXUpper, bounds.maxX);
    next.minYUpper = Math.min(next.minYUpper, bounds.maxY);
    next.maxXLower = Math.max(next.maxXLower, bounds.minX);
    next.maxYLower = Math.max(next.maxYLower, bounds.minY);
  }
  return next;
}
