import type { InkElementV1, InkSnapshotV1, StrokeElementV1 } from "../../domain/schema/public";
import { encodeStrokeSamples, encodeStrokeSamplesSteps } from "./stroke-sample-codec";

const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_ELEMENTS = 20_000;

interface Entry {
  readonly points: ArrayLike<number>;
  readonly encoding: string;
  readonly bytes: number;
  retired: boolean;
}

/** Session-owned compact samples, reused only for immutable current-model identities. */
export class StrokeSampleEncodingCache {
  readonly #entries = new Map<string, Entry>();
  #bytes = 0;
  #builds = 0;
  #hits = 0;

  public constructor(readonly ownsStroke: (stroke: StrokeElementV1) => boolean = () => false) {}

  public get instrumentation() {
    return {
      sampleEncodingBuilds: this.#builds,
      sampleEncodingHits: this.#hits,
      sampleEncodingCacheBytes: this.#bytes,
      sampleEncodingCacheElements: this.#entries.size,
    };
  }

  public resolve(stroke: StrokeElementV1): string {
    const steps = this.#resolveSteps(stroke, undefined, true);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  }

  public *resolveSteps(stroke: StrokeElementV1, signal?: AbortSignal): Generator<void, string> {
    return yield* this.#resolveSteps(stroke, signal, false);
  }

  *#resolveSteps(
    stroke: StrokeElementV1,
    signal: AbortSignal | undefined,
    synchronous: boolean,
  ): Generator<void, string> {
    signal?.throwIfAborted();
    const entry = this.#entries.get(stroke.id);
    const owned = this.ownsStroke(stroke);
    if (owned && entry?.points === stroke.points) {
      entry.retired = false;
      this.#entries.delete(stroke.id);
      this.#entries.set(stroke.id, entry);
      this.#hits += 1;
      return entry.encoding;
    }
    const encoding = synchronous
      ? encodeStrokeSamples(stroke.points)
      : yield* encodeStrokeSamplesSteps(stroke.points, signal);
    signal?.throwIfAborted();
    this.#builds += 1;
    if (this.ownsStroke(stroke)) this.retainDecoded(stroke.id, stroke.points, encoding);
    else if (entry?.points === stroke.points && this.#entries.get(stroke.id) === entry) {
      this.remove(stroke.id);
    }
    return encoding;
  }

  /** Parser-private staging only; publication requires successful complete document validation. */
  public retainDecoded(id: string, points: ArrayLike<number>, encoding: string): void {
    this.remove(id);
    const bytes = 128 + id.length * 2 + encoding.length * 2 + points.length * 8;
    if (bytes > MAX_CACHE_BYTES) return;
    while (this.#bytes + bytes > MAX_CACHE_BYTES || this.#entries.size >= MAX_CACHE_ELEMENTS) {
      this.remove(this.#entries.keys().next().value!);
    }
    this.#entries.set(id, { points, encoding, bytes, retired: false });
    this.#bytes += bytes;
  }

  public adoptValidated(
    source: StrokeSampleEncodingCache,
    snapshot: InkSnapshotV1,
    sourceVersion: number,
  ): void {
    this.clear();
    if (sourceVersion !== 1) return;
    for (const element of snapshot.elements) {
      const entry = source.#entries.get(element.id);
      if (element.kind === "stroke" && entry?.points === element.points) {
        this.retainDecoded(element.id, element.points, entry.encoding);
      }
    }
  }

  public reconcile(snapshot: InkSnapshotV1): void {
    const active = new Map(snapshot.elements.map((element) => [element.id, element]));
    this.reconcileElements(active);
  }

  public reconcileElements(active: ReadonlyMap<string, InkElementV1>): void {
    for (const [id, entry] of this.#entries) {
      const element = active.get(id);
      if (entry.retired || element?.kind !== "stroke" || element.points !== entry.points)
        this.remove(id);
    }
  }

  public reconcileElement(element: InkElementV1): void {
    const entry = this.#entries.get(element.id);
    if (element.kind !== "stroke" || element.points !== entry?.points) this.remove(element.id);
  }

  /** Call before removal, while exclusive immutable runtime ownership can still be proved. */
  public retire(stroke: InkElementV1 | undefined): void {
    if (stroke === undefined) return;
    const entry = this.#entries.get(stroke.id);
    if (
      stroke.kind === "stroke" &&
      stroke.points instanceof Float64Array &&
      entry?.points === stroke.points &&
      this.ownsStroke(stroke)
    ) {
      entry.retired = true;
    } else this.remove(stroke.id);
  }

  public remove(id: string): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) return;
    this.#entries.delete(id);
    this.#bytes -= entry.bytes;
  }

  public clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
    this.#builds = 0;
    this.#hits = 0;
  }
}
