import { renderBandOf, type RenderBand } from "../commands/render-bands";
import { FILE_SCHEMA_LIMITS } from "../schema/constants";
import { validateRuntimeInkElementV1 } from "../schema/element-validation";
import type { ElementValidationDerivation, InkElementV1 } from "../schema/public";
import { UniformSpatialIndex } from "../spatial/index";

import { assertResolvedConnections, connectionReferences } from "./connections";
import { DocumentCapacity } from "./document-capacity";
import {
  createInitialRecord,
  createOwnedInitialRecord,
  createOwnedValidatedInitialRecord,
} from "./record-factory";
import { assertValidElement } from "./replacement-planner";
import { StoreAppendBuilder } from "./store-append-builder";
import type { ElementRecord, EndpointReference, StoreSliceScheduler } from "./types";

interface InitialRankEntry {
  readonly band: RenderBand;
  readonly rank: number;
}

export interface TimeSlicedStoreState {
  readonly bands: Record<RenderBand, string[]>;
  readonly capacity: DocumentCapacity;
  readonly elementCount: number;
  readonly index: UniformSpatialIndex<string>;
  readonly overflowCount: number;
  readonly ranks: Map<string, InitialRankEntry>;
  readonly records: Map<string, ElementRecord>;
  readonly reverseConnections: Map<string, EndpointReference[]>;
  readonly yields: number;
}

export class TimeSlicedStoreBuilder extends StoreAppendBuilder {
  readonly #bands: Record<RenderBand, string[]> = { content: [], highlight: [] };
  readonly #capacity = new DocumentCapacity();
  #cancelled = false;
  #finished = false;
  #index = new UniformSpatialIndex<string>();
  readonly #ranks = new Map<string, InitialRankEntry>();
  readonly #records = new Map<string, ElementRecord>();
  readonly #scheduler: StoreSliceScheduler;
  #yields = 0;

  public constructor(scheduler: StoreSliceScheduler) {
    super();
    this.#scheduler = scheduler;
  }

  protected override async appendBatch(
    elements: readonly InkElementV1[],
    ownsRuntimeElements: boolean,
  ): Promise<"accepted" | "cancelled"> {
    return this.#append(elements, ownsRuntimeElements);
  }

  public appendOwnedValidatedRuntime(
    elements: readonly InkElementV1[],
    derivations: readonly ElementValidationDerivation[],
  ): Promise<"accepted" | "cancelled"> {
    if (elements.length !== derivations.length) {
      throw new TypeError("Validated element derivations are incomplete.");
    }
    return this.#append(elements, true, derivations);
  }

  async #append(
    elements: readonly InkElementV1[],
    ownsRuntimeElements: boolean,
    derivations?: readonly ElementValidationDerivation[],
  ): Promise<"accepted" | "cancelled"> {
    this.#assertOpen();
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index]!;
      if (this.#isCancelled()) return this.#cancel();
      if (derivations === undefined) {
        if (ownsRuntimeElements) assertValidRuntimeElement(element);
        else assertValidElement(element);
      }
      if (this.#records.has(element.id))
        throw new RangeError(`Duplicate element ID: ${element.id}`);
      const derivation = derivations?.[index];
      const record =
        derivation === undefined
          ? ownsRuntimeElements
            ? createOwnedInitialRecord(element)
            : createInitialRecord(element)
          : createOwnedValidatedInitialRecord(element, derivation);
      const capacityPatch = this.#capacity.prepare([], [record]);
      this.#index.insert(element.id, record.bounds);
      this.#capacity.commit(capacityPatch);
      this.#records.set(element.id, record);
      const band = renderBandOf(element);
      this.#ranks.set(element.id, { band, rank: this.#bands[band].length });
      this.#bands[band].push(element.id);
      this.#yields += await yieldWhenRequested(this.#scheduler);
    }
    return "accepted";
  }

  public async finalize(): Promise<TimeSlicedStoreState | "cancelled"> {
    this.#assertOpen();
    this.#finished = true;
    const reverseConnections = new Map<string, EndpointReference[]>();
    const lookup = (id: string) => this.#records.get(id)?.element;
    for (const record of this.#records.values()) {
      if (this.#isCancelled()) return this.#cancel();
      assertResolvedConnections(record.element, lookup);
      for (const { reference, targetId } of connectionReferences(record.element)) {
        const references = reverseConnections.get(targetId) ?? [];
        if (references.length >= FILE_SCHEMA_LIMITS.connectedEndpointsPerTarget) {
          throw new RangeError("The per-target connected-endpoint limit was exceeded.");
        }
        if (!reverseConnections.has(targetId)) reverseConnections.set(targetId, references);
        references.push(Object.freeze(reference));
      }
      this.#yields += await yieldWhenRequested(this.#scheduler);
    }
    return {
      bands: this.#bands,
      capacity: this.#capacity,
      elementCount: this.#records.size,
      index: this.#index,
      overflowCount: this.#index.overflowCount,
      ranks: this.#ranks,
      records: this.#records,
      reverseConnections,
      yields: this.#yields,
    };
  }

  public cancel(): void {
    this.#cancel();
  }

  #assertOpen(): void {
    if (this.#cancelled || this.#finished) throw new Error("The store builder is closed.");
  }

  #cancel(): "cancelled" {
    this.#cancelled = true;
    this.#bands.content.length = 0;
    this.#bands.highlight.length = 0;
    this.#index = new UniformSpatialIndex<string>();
    this.#ranks.clear();
    this.#records.clear();
    return "cancelled";
  }

  #isCancelled(): boolean {
    return this.#cancelled || (this.#scheduler.isCancelled?.() ?? false);
  }
}

async function yieldWhenRequested(scheduler: StoreSliceScheduler): Promise<number> {
  if (!scheduler.shouldYield()) return 0;
  await scheduler.yieldControl();
  return 1;
}

function assertValidRuntimeElement(element: InkElementV1): void {
  const result = validateRuntimeInkElementV1(element);
  if (!result.ok) throw new RangeError(`Invalid runtime element: ${result.error.code}`);
}
