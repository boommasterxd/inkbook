import type { MountedSceneElement } from "../content/mounted-element";
import type { SceneDeltaEntry, SceneElementRecord, SceneStorePort } from "../types";
import { elementBytes } from "./preview-memory";

interface RunTarget {
  readonly entry: MountedSceneElement;
  current: SceneElementRecord;
  latest: SceneElementRecord;
  phase: number;
}

/** Pins one drain target while later committed records coalesce by member ID. */
export class SelectionRunTargets {
  #members = new Map<string, RunTarget>();
  #phase = 0;
  #capturing = false;
  #draining = false;
  #hasNext = false;
  #bytes = 0;
  #payloadBytes = 0;

  /** Called by the existing cooperatively admitted run-member preparation. */
  public prepare(entry: MountedSceneElement, record: SceneElementRecord): void {
    const previous = this.#members.get(entry.id);
    if (previous === undefined) this.#bytes += 128 + entry.id.length * 2;
    else this.#payloadBytes -= this.payloadBytes(previous);
    this.#payloadBytes += elementBytes(record.element);
    this.#members.set(entry.id, { entry, current: record, latest: record, phase: this.#phase });
  }

  /** Reuses the existing committed-delta visit; native adapters provide all fields. */
  public capture(id: string, change: SceneDeltaEntry, store: SceneStorePort): boolean {
    const member = this.#members.get(id);
    if (member === undefined || change.after === null) return false;
    const record = this.capturedRecord(member, change, store);
    if (record === undefined) return false;
    if (!this.#draining && !this.#capturing) {
      this.#phase += 1;
      this.#capturing = true;
    }
    this.promote(member);
    const previousBytes = this.payloadBytes(member);
    member.latest = record;
    if (this.#draining) this.#hasNext = true;
    else member.current = record;
    this.#payloadBytes += this.payloadBytes(member) - previousBytes;
    return true;
  }

  public begin(): void {
    this.#capturing = false;
    this.#draining = true;
  }

  public record(id: string): SceneElementRecord | undefined {
    const member = this.#members.get(id);
    if (member === undefined) return undefined;
    this.promote(member);
    return member.current;
  }

  /** Advances the epoch only; members promote lazily before reads or later captures. */
  public finish(): boolean {
    if (!this.#hasNext) {
      this.#draining = false;
      this.#capturing = false;
      return false;
    }
    this.#phase += 1;
    this.#hasNext = false;
    return true;
  }

  public discard(): void {
    this.#members = new Map();
    this.#phase = 0;
    this.#capturing = false;
    this.#draining = false;
    this.#hasNext = false;
    this.#bytes = 0;
    this.#payloadBytes = 0;
  }

  /** Retained estimate with per-member identity reuse; live Store aliases may overcount. */
  public memoryUsage(): number {
    return 64 + this.#bytes + this.#payloadBytes;
  }

  private promote(member: RunTarget): void {
    if (member.phase === this.#phase) return;
    const previousBytes = this.payloadBytes(member);
    member.current = member.latest;
    member.phase = this.#phase;
    this.#payloadBytes += this.payloadBytes(member) - previousBytes;
  }

  private payloadBytes(member: RunTarget): number {
    const current = member.current.element;
    const latest = member.latest.element;
    if (current === latest) return elementBytes(current);
    const bytes = elementBytes(current) + elementBytes(latest);
    return current.kind === "stroke" && latest.kind === "stroke" && current.points === latest.points
      ? bytes - current.points.length * 8
      : bytes;
  }

  private capturedRecord(
    member: RunTarget,
    change: SceneDeltaEntry,
    store: SceneStorePort,
  ): SceneElementRecord | undefined {
    if (
      change.after == null ||
      change.afterBounds == null ||
      change.afterGeometryVersion === undefined ||
      change.afterPaintVersion === undefined
    )
      return store.get(change.id);
    return Object.freeze({
      id: change.id,
      element: change.after,
      bounds: change.afterBounds,
      geometryVersion: change.afterGeometryVersion,
      paintVersion: change.afterPaintVersion,
      band: member.entry.band,
      rank: member.entry.rank,
    });
  }
}
