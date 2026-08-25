import type { ElementValidationDerivation, InkElementV1 } from "../schema/public";

import { StoreAppendBuilder } from "./store-append-builder";
import { TimeSlicedStoreBuilder } from "./time-sliced-store-creation";
import type { TimeSlicedStoreState } from "./time-sliced-store-creation";
import type { StoreSliceScheduler } from "./types";

export interface ElementStoreBuilder<TStore> {
  append(elements: readonly InkElementV1[]): Promise<"accepted" | "cancelled">;
  /** Validates runtime elements and adopts their exclusively owned nested buffers. */
  appendOwnedRuntime(elements: readonly InkElementV1[]): Promise<"accepted" | "cancelled">;
  /** Adopts runtime elements with derivations produced by their completed snapshot validation. */
  appendOwnedValidatedRuntime(
    elements: readonly InkElementV1[],
    derivations: readonly ElementValidationDerivation[],
  ): Promise<"accepted" | "cancelled">;
  cancel(): void;
  finalize(): Promise<TStore | null>;
}

class DefaultElementStoreBuilder<TStore>
  extends StoreAppendBuilder
  implements ElementStoreBuilder<TStore>
{
  readonly #builder: TimeSlicedStoreBuilder;
  #cancelled = false;
  #finalized = false;
  readonly #publish: (state: TimeSlicedStoreState) => TStore;

  public constructor(
    scheduler: StoreSliceScheduler,
    publish: (state: TimeSlicedStoreState) => TStore,
  ) {
    super();
    this.#builder = new TimeSlicedStoreBuilder(scheduler);
    this.#publish = publish;
  }

  protected override async appendBatch(
    elements: readonly InkElementV1[],
    ownsRuntimeElements: boolean,
  ): Promise<"accepted" | "cancelled"> {
    if (this.#cancelled) return "cancelled";
    try {
      const status = ownsRuntimeElements
        ? await this.#builder.appendOwnedRuntime(elements)
        : await this.#builder.append(elements);
      if (status === "cancelled") this.#cancelled = true;
      return status;
    } catch (error) {
      this.cancel();
      throw error;
    }
  }

  public async appendOwnedValidatedRuntime(
    elements: readonly InkElementV1[],
    derivations: readonly ElementValidationDerivation[],
  ): Promise<"accepted" | "cancelled"> {
    if (this.#cancelled) return "cancelled";
    try {
      const status = await this.#builder.appendOwnedValidatedRuntime(elements, derivations);
      if (status === "cancelled") this.#cancelled = true;
      return status;
    } catch (error) {
      this.cancel();
      throw error;
    }
  }

  public cancel(): void {
    if (this.#cancelled || this.#finalized) return;
    this.#cancelled = true;
    this.#builder.cancel();
  }

  public async finalize(): Promise<TStore | null> {
    if (this.#cancelled) return null;
    try {
      const state = await this.#builder.finalize();
      if (state === "cancelled") {
        this.#cancelled = true;
        return null;
      }
      this.#finalized = true;
      return this.#publish(state);
    } catch (error) {
      this.cancel();
      throw error;
    }
  }
}

export function createElementStoreBuilder<TStore>(
  scheduler: StoreSliceScheduler,
  publish: (state: TimeSlicedStoreState) => TStore,
): ElementStoreBuilder<TStore> {
  return new DefaultElementStoreBuilder(scheduler, publish);
}
