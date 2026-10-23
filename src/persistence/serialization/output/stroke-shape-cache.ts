import type { SvgPathPart } from "../../../domain/geometry/element-path";
import { CanonicalElementPathPreparation } from "../../../domain/geometry/canonical-element-path-preparation";
import { strokeLocalGeometry } from "../../../domain/geometry/stroke-position";
import type { StrokeElementV1 } from "../../../domain/schema/public";

interface Entry {
  stroke: StrokeElementV1;
  readonly parts: readonly SvgPathPart[];
  readonly bytes: number;
  retired: boolean;
}

/** Session-owned local contours survive placement changes without retaining unbounded history. */
export class StrokeShapeCache {
  readonly #entries = new Map<string, Entry>();
  #bytes = 0;
  #builds = 0;
  #retiredPointComparisons = 0;
  public constructor(readonly mayRetain: (stroke: StrokeElementV1) => boolean = () => true) {}
  public get instrumentation() {
    return {
      shapeBuilds: this.#builds,
      shapeCacheBytes: this.#bytes,
      shapeCacheElements: this.#entries.size,
      retiredPointComparisons: this.#retiredPointComparisons,
    };
  }
  public resolve(stroke: StrokeElementV1): readonly SvgPathPart[] {
    const steps = this.resolveSteps(stroke);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  }
  public *resolveSteps(
    stroke: StrokeElementV1,
    signal?: AbortSignal,
  ): Generator<void, readonly SvgPathPart[]> {
    const cached = yield* this.readSteps(stroke, signal);
    if (cached !== undefined) return cached;
    const parts = yield* prepareStrokeShapeSteps(stroke, signal);
    signal?.throwIfAborted();
    this.#builds += 1;
    if (this.mayRetain(stroke)) this.#retain(strokeLocalGeometry(stroke), parts);
    return parts;
  }
  public read(stroke: StrokeElementV1): readonly SvgPathPart[] | undefined {
    const steps = this.readSteps(stroke);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  }
  public *readSteps(
    stroke: StrokeElementV1,
    signal?: AbortSignal,
  ): Generator<void, readonly SvgPathPart[] | undefined> {
    signal?.throwIfAborted();
    const local = strokeLocalGeometry(stroke);
    const cached = this.#entries.get(stroke.id);
    if (
      cached !== undefined &&
      sameShapeFields(cached.stroke, local) &&
      (cached.stroke.points === local.points ||
        (cached.retired &&
          (yield* this.#samePointValuesSteps(cached.stroke.points, local.points, signal))))
    ) {
      signal?.throwIfAborted();
      if (!this.mayRetain(stroke) || this.#entries.get(stroke.id) !== cached) return cached.parts;
      this.#entries.delete(stroke.id);
      cached.stroke = local;
      cached.retired = false;
      this.#entries.set(stroke.id, cached);
      return cached.parts;
    }
    return undefined;
  }
  /** Uses the same bounded canonical geometry steps as a cold scene path. */
  public async prepare(
    stroke: StrokeElementV1,
    context: { readonly signal: AbortSignal; checkpoint(): Promise<void> | undefined },
  ): Promise<readonly SvgPathPart[]> {
    const steps = this.resolveSteps(stroke, context.signal);
    try {
      for (;;) {
        context.signal.throwIfAborted();
        const pending = context.checkpoint();
        if (pending !== undefined) await pending;
        context.signal.throwIfAborted();
        const step = steps.next();
        if (step.done) return step.value;
      }
    } finally {
      steps.return(undefined as never);
    }
  }
  /** A validated current-model contour produced by the active Store scene. */
  public seed(stroke: StrokeElementV1, d: string): void {
    if (!this.mayRetain(stroke)) return;
    const local = strokeLocalGeometry(stroke);
    const cached = this.#entries.get(stroke.id);
    if (cached?.stroke.points === local.points && sameShapeFields(cached.stroke, local)) return;
    this.#retain(local, [{ d, paint: "fill" }]);
  }
  #retain(local: StrokeElementV1, parts: readonly SvgPathPart[]): void {
    const bytes =
      512 +
      local.id.length * 2 +
      parts.reduce((sum, part) => sum + 64 + part.d.length * 2, 0) +
      local.points.length * 8;
    this.remove(local.id);
    if (bytes > 32 * 1024 * 1024) return;
    this.#entries.set(local.id, { stroke: local, parts, bytes, retired: false });
    this.#bytes += bytes;
    while (this.#bytes > 32 * 1024 * 1024 || this.#entries.size > 20_000) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }
  public remove(id: string): void {
    const entry = this.#entries.get(id);
    if (entry !== undefined) this.#bytes -= entry.bytes;
    this.#entries.delete(id);
  }
  /** Keep removed geometry inside the existing LRU for a possible Undo. */
  public retire(id: string): void {
    const entry = this.#entries.get(id);
    if (entry !== undefined) entry.retired = true;
  }
  public ids(): IterableIterator<string> {
    return this.#entries.keys();
  }
  public clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
    this.#builds = 0;
    this.#retiredPointComparisons = 0;
  }
  *#samePointValuesSteps(
    left: StrokeElementV1["points"],
    right: StrokeElementV1["points"],
    signal?: AbortSignal,
  ): Generator<void, boolean> {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      this.#retiredPointComparisons += 1;
      if (!Object.is(left[index], right[index])) return false;
      if ((index + 1) % 768 === 0) {
        signal?.throwIfAborted();
        yield;
      }
    }
    return true;
  }
}

/** Shared cold geometry producer for cache-backed and uncached element fragments. */
export function* prepareStrokeShapeSteps(
  stroke: StrokeElementV1,
  signal?: AbortSignal,
): Generator<void, readonly SvgPathPart[]> {
  const job = new CanonicalElementPathPreparation(stroke, undefined, "path-only");
  try {
    for (;;) {
      signal?.throwIfAborted();
      if (job.stepOperation()) return job.parts!;
      yield;
    }
  } finally {
    job.cancel();
  }
}

function sameShapeFields(left: StrokeElementV1, right: StrokeElementV1): boolean {
  return (
    left.rotation === right.rotation &&
    (left.rotation === 0 || (left.pivot.x === right.pivot.x && left.pivot.y === right.pivot.y)) &&
    left.tool === right.tool &&
    left.style.width === right.style.width &&
    left.style.pressureEnabled === right.style.pressureEnabled
  );
}
