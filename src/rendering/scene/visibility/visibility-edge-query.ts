import type { Bounds } from "../../../domain/geometry/primitives";
import type { MutableSceneInstrumentation, SceneElementRecord, SceneStorePort } from "../types";
import { envelopeFringes, intersects } from "./visibility-bounds";

interface EdgeChanges {
  readonly entered: readonly SceneElementRecord[];
  readonly exited: readonly string[];
}

export type EdgeProgress = EdgeChanges | "pending";

/** Reuses one deduplicated fringe buffer across overlapping camera movements. */
export class VisibilityEdgeQuery {
  readonly #ids: string[] = [];
  readonly #seen = new Set<string>();
  readonly #entered: SceneElementRecord[] = [];
  readonly #exited: string[] = [];
  readonly #fringes: Bounds[] = [];
  #queryCursor = 0;
  #cursor = 0;
  #current: Bounds | undefined;
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
    if (!sameBounds(this.#current, current)) {
      this.release();
      this.#current = current;
      this.#fringes.push(
        ...envelopeFringes(previous, current),
        ...envelopeFringes(current, previous),
      );
    }
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
      const record = this.store.get(id);
      const visible = record !== undefined && intersects(current, record.bounds);
      if (visible === wasVisible(id)) continue;
      if (visible && record !== undefined) this.#entered.push(record);
      else this.#exited.push(id);
    }
    return { entered: this.#entered, exited: this.#exited };
  }

  public release(): void {
    this.#spatialCursor?.cancel();
    this.#spatialCursor = undefined;
    this.#ids.length = 0;
    this.#seen.clear();
    this.#entered.length = 0;
    this.#exited.length = 0;
    this.#fringes.length = 0;
    this.#queryCursor = 0;
    this.#cursor = 0;
    this.#current = undefined;
  }

  public get pending(): boolean {
    return (
      this.#current !== undefined &&
      (this.#queryCursor < this.#fringes.length || this.#cursor < this.#ids.length)
    );
  }

  public memoryUsage(): number {
    return (
      this.#ids.length * 16 +
      this.#seen.size * 32 +
      this.#entered.length * 8 +
      this.#exited.length * 16 +
      (this.#spatialCursor?.memoryUsage?.() ?? 0)
    );
  }
}

function sameBounds(left: Bounds | undefined, right: Bounds): boolean {
  return (
    left !== undefined &&
    left.minX === right.minX &&
    left.minY === right.minY &&
    left.maxX === right.maxX &&
    left.maxY === right.maxY
  );
}
