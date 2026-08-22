import type { InkElementV1, InkSnapshotV1, PageV1 } from "../../../domain/schema/public";
import { CoalescedExportTarget, type CoalescedExportPlan } from "../../worker/coalesced-export";
import type { AutosaveDelta, AutosaveDocumentSource } from "./types";

export class AutosaveWorkerModelState {
  #modelRevision: number;
  #pending: CoalescedExportTarget<InkElementV1, PageV1> | null = null;

  public constructor(modelRevision: number) {
    this.#modelRevision = modelRevision;
  }

  public get modelRevision(): number {
    return this.#modelRevision;
  }

  public get requiresFullSynchronization(): boolean {
    return this.#pending?.requiresFullSnapshot === true;
  }

  public record(delta: AutosaveDelta, inFlightRevision?: number): void {
    this.#target(inFlightRevision).record(delta);
  }

  public takePlan(
    document: AutosaveDocumentSource,
  ): CoalescedExportPlan<InkElementV1, PageV1, InkSnapshotV1> | null {
    const pending = this.#pending;
    if (pending === null) return null;
    this.#pending = null;
    return pending.materialize({
      orderByBand: document.orderByBand(),
      ...(pending.requiresFullSnapshot ? { snapshot: document.snapshot() } : {}),
    });
  }

  public acknowledgeExport(modelRevision: number): void {
    this.#modelRevision = modelRevision;
  }

  public acknowledgeSynchronization(modelRevision: number): void {
    this.#modelRevision = modelRevision;
    if (this.#pending !== null) return;
    this.#pending = new CoalescedExportTarget(modelRevision, ({ id }) => id);
    this.#pending.record({ modelRevision });
  }

  public requireFull(modelRevision: number, inFlightRevision?: number): void {
    this.#target(inFlightRevision).requireFullSnapshot(modelRevision);
  }

  public clear(): void {
    this.#pending = null;
  }

  #target(inFlightRevision?: number): CoalescedExportTarget<InkElementV1, PageV1> {
    if (this.#pending === null) {
      this.#pending = new CoalescedExportTarget(
        inFlightRevision ?? this.#modelRevision,
        ({ id }) => id,
      );
    }
    return this.#pending;
  }
}
