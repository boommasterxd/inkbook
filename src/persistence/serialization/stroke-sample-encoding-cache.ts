import type { InkSnapshotV1, StrokeElementV1 } from "../../domain/schema/public";
import { encodeStrokeSamples } from "./stroke-sample-codec";

const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_ELEMENTS = 20_000;

interface Entry {
  readonly points: ArrayLike<number>;
  readonly encoding: string;
  readonly bytes: number;
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
    const entry = this.#entries.get(stroke.id);
    const owned = this.ownsStroke(stroke);
    if (owned && entry?.points === stroke.points) {
      this.#entries.delete(stroke.id);
      this.#entries.set(stroke.id, entry);
      this.#hits += 1;
      return entry.encoding;
    }
    const encoding = encodeStrokeSamples(stroke.points);
    this.#builds += 1;
    this.remove(stroke.id);
    if (owned) this.retainDecoded(stroke.id, stroke.points, encoding);
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
    this.#entries.set(id, { points, encoding, bytes });
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
    for (const [id, entry] of this.#entries) {
      const element = active.get(id);
      if (element?.kind !== "stroke" || element.points !== entry.points) this.remove(id);
    }
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
