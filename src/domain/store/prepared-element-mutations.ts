import {
  planElementMutation,
  type ElementMutationPlan,
  type MutationSource,
} from "./element-mutation";
import { createRemovalMutationTimeSliced } from "./removal-mutation";
import { createRemovalTransition } from "./removal-transition";
import { captureOwnedMutationHistory, type OwnedMutationHistory } from "./owned-mutation-history";
import type {
  AppliedElementMutation,
  ElementMutation,
  ElementMutationCommitResult,
  PreparedElementMutation,
  PreparedElementMutationResult,
  StoreSliceScheduler,
  StoreDelta,
} from "./types";

interface VersionedMutationSource extends MutationSource {
  readonly mutationVersion: number;
}

export class PreparedElementMutations {
  readonly #adopt: (plan: ElementMutationPlan) => ElementMutationCommitResult;
  readonly #prepared = new WeakMap<
    PreparedElementMutation,
    { readonly mutationVersion: number; readonly plan: ElementMutationPlan }
  >();
  readonly #readVersion: () => number;
  readonly #readSource: () => VersionedMutationSource;
  readonly #trustedRemovalVersions = new WeakMap<ElementMutation, number>();
  readonly #ownedHistory = new WeakMap<AppliedElementMutation, OwnedMutationHistory>();

  public constructor(
    readSource: () => VersionedMutationSource,
    readVersion: () => number,
    adopt: (plan: ElementMutationPlan) => ElementMutationCommitResult,
  ) {
    this.#readSource = readSource;
    this.#readVersion = readVersion;
    this.#adopt = adopt;
  }

  public async createRemovalMutationTimeSliced(
    ids: ReadonlySet<string> | readonly string[],
    scheduler: StoreSliceScheduler,
  ): Promise<ElementMutation | "cancelled" | null> {
    const source = this.#readSource();
    const mutation = await createRemovalMutationTimeSliced(ids, source.records, source.bands, {
      isCancelled: () =>
        source.mutationVersion !== this.#readVersion() || (scheduler.isCancelled?.() ?? false),
      shouldYield: scheduler.shouldYield,
      yieldControl: scheduler.yieldControl,
    });
    if (source.mutationVersion !== this.#readVersion() || scheduler.isCancelled?.())
      return "cancelled";
    if (mutation === null || mutation === "cancelled") return mutation;
    this.#trustedRemovalVersions.set(mutation, source.mutationVersion);
    return mutation;
  }

  public async prepare(
    mutation: ElementMutation,
    scheduler: StoreSliceScheduler,
    replay?: AppliedElementMutation,
  ): Promise<PreparedElementMutationResult> {
    const source = this.#readSource();
    const plan = await planElementMutation(
      source,
      mutation,
      {
        isCancelled: () =>
          source.mutationVersion !== this.#readVersion() || (scheduler.isCancelled?.() ?? false),
        shouldYield: scheduler.shouldYield,
        yieldControl: scheduler.yieldControl,
      },
      replay,
      replay === undefined && this.#trustedRemovalVersions.get(mutation) === source.mutationVersion,
      replay === undefined ? undefined : this.#ownedHistory.get(replay),
    );
    if (plan === "cancelled" || source.mutationVersion !== this.#readVersion()) {
      return { status: "cancelled", token: null };
    }
    if (plan === null) return { status: "noop", token: null };
    const token = Object.freeze({}) as PreparedElementMutation;
    this.#prepared.set(token, { mutationVersion: source.mutationVersion, plan });
    return { status: "prepared", token };
  }

  public commit(token: PreparedElementMutation): ElementMutationCommitResult {
    const prepared = this.#prepared.get(token);
    this.#prepared.delete(token);
    if (prepared === undefined || prepared.mutationVersion !== this.#readVersion()) {
      return { delta: null, status: "cancelled", transition: null };
    }
    const result = this.#adopt(prepared.plan);
    if (result.transition !== null && prepared.plan.ownedHistory !== undefined) {
      this.#ownedHistory.set(result.transition, prepared.plan.ownedHistory);
    }
    return result;
  }

  public retainRemoval(
    delta: StoreDelta,
    beforeBands: ElementMutation["bands"],
    afterBands: ElementMutation["bands"],
  ): AppliedElementMutation {
    const transition = createRemovalTransition(delta, beforeBands, afterBands);
    const owned = captureOwnedMutationHistory(delta);
    const retained = Object.freeze({
      ...transition,
      payloadBytes: transition.payloadBytes + owned.payloadBytes,
    });
    this.#ownedHistory.set(retained, owned);
    return retained;
  }
}
