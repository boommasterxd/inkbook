import { FILE_SCHEMA_LIMITS } from "../schema/constants";

import { connectionReferences } from "./connections";
import type { ElementRecord, StoreSliceScheduler } from "./types";

interface CapacityTotals {
  connectedEndpoints: number;
  elements: number;
  strokePoints: number;
  strokes: number;
}

export interface DocumentCapacityPatch {
  consumed: boolean;
  readonly fanout: ReadonlyMap<string, number>;
  readonly generation: number;
  readonly totals: Readonly<CapacityTotals>;
}

export class DocumentCapacity {
  readonly #fanout = new Map<string, number>();
  #generation = 0;
  #totals: CapacityTotals = { connectedEndpoints: 0, elements: 0, strokePoints: 0, strokes: 0 };

  public addInitial(record: ElementRecord): void {
    this.commit(this.prepare([], [record]));
  }

  public prepare(
    previous: readonly ElementRecord[],
    next: readonly ElementRecord[],
  ): DocumentCapacityPatch {
    const totals = { ...this.#totals };
    const fanout = new Map<string, number>();
    for (const record of previous) applyRecord(totals, fanout, this.#fanout, record, -1);
    for (const record of next) applyRecord(totals, fanout, this.#fanout, record, 1);
    assertTotals(totals);
    return { consumed: false, fanout, generation: this.#generation, totals };
  }

  public async prepareTimeSliced(
    previous: readonly ElementRecord[],
    next: readonly ElementRecord[],
    scheduler: StoreSliceScheduler,
  ): Promise<{ readonly patch: DocumentCapacityPatch; readonly yields: number } | "cancelled"> {
    const totals = { ...this.#totals };
    const fanout = new Map<string, number>();
    let yields = 0;
    for (const [records, direction] of [
      [previous, -1],
      [next, 1],
    ] as const) {
      for (const record of records) {
        if (cancelled(scheduler)) return "cancelled";
        applyRecord(totals, fanout, this.#fanout, record, direction);
        if (scheduler.shouldYield()) {
          await scheduler.yieldControl();
          if (cancelled(scheduler)) return "cancelled";
          yields += 1;
        }
      }
    }
    assertTotals(totals);
    return {
      patch: { consumed: false, fanout, generation: this.#generation, totals },
      yields,
    };
  }

  public prepareUnchanged(): DocumentCapacityPatch {
    return {
      consumed: false,
      fanout: new Map(),
      generation: this.#generation,
      totals: this.#totals,
    };
  }

  public validateReplacementBounds(record: ElementRecord): void {
    assertBounds(record);
  }

  public commit(patch: DocumentCapacityPatch): void {
    if (patch.consumed || patch.generation !== this.#generation) {
      throw new Error("The prepared document-capacity patch is stale.");
    }
    patch.consumed = true;
    this.#totals = patch.totals;
    for (const [targetId, count] of patch.fanout) {
      if (count === 0) this.#fanout.delete(targetId);
      else this.#fanout.set(targetId, count);
    }
    this.#generation += 1;
  }
}

function cancelled(scheduler: StoreSliceScheduler): boolean {
  return scheduler.isCancelled?.() ?? false;
}

function applyRecord(
  totals: CapacityTotals,
  fanoutPatch: Map<string, number>,
  currentFanout: ReadonlyMap<string, number>,
  record: ElementRecord,
  direction: -1 | 1,
): void {
  if (direction === 1) assertBounds(record);
  totals.elements += direction;
  if (record.element.kind === "stroke") {
    totals.strokes += direction;
    totals.strokePoints += direction * (record.element.points.length / 3);
  }
  const connections = connectionReferences(record.element);
  totals.connectedEndpoints += direction * connections.length;
  for (const { targetId } of connections) {
    const count = fanoutPatch.get(targetId) ?? currentFanout.get(targetId) ?? 0;
    const nextCount = count + direction;
    assertFanoutCount(nextCount);
    fanoutPatch.set(targetId, nextCount);
  }
}

function assertBounds(record: ElementRecord): void {
  const maximumHeight = FILE_SCHEMA_LIMITS.maximumDerivedHeight;
  if (maximumHeight !== null && record.bounds.maxY > maximumHeight) {
    throw new RangeError("The maximum derived document height was exceeded.");
  }
}

function assertTotals(totals: CapacityTotals): void {
  if (totals.elements < 0 || totals.elements > FILE_SCHEMA_LIMITS.elements) {
    throw new RangeError("The document element limit was exceeded.");
  }
  if (totals.strokes < 0 || totals.strokes > FILE_SCHEMA_LIMITS.strokes) {
    throw new RangeError("The document stroke limit was exceeded.");
  }
  if (totals.strokePoints < 0 || totals.strokePoints > FILE_SCHEMA_LIMITS.strokePoints) {
    throw new RangeError("The document stroke-point limit was exceeded.");
  }
  if (
    totals.connectedEndpoints < 0 ||
    totals.connectedEndpoints > FILE_SCHEMA_LIMITS.connectedEndpoints
  ) {
    throw new RangeError("The document connected-endpoint limit was exceeded.");
  }
}

function assertFanoutCount(count: number): void {
  if (count > FILE_SCHEMA_LIMITS.connectedEndpointsPerTarget) {
    throw new RangeError("The per-target connected-endpoint limit was exceeded.");
  }
  if (count < 0) throw new Error("Document capacity state is inconsistent.");
}
