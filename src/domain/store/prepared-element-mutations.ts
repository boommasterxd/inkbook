import {
  planElementMutation,
  type ElementMutationPlan,
  type MutationSource,
} from "./element-mutation";
import { createRemovalMutationTimeSliced } from "./removal-mutation";
import { createRemovalTransition } from "./removal-transition";
import { ownedHistoryReplaySteps } from "./owned-history-replay";
import { MutationPreparationScheduler } from "./mutation-preparation-scheduler";
import type { MutationOrder } from "./mutation-order";
import { prepareArrangementMutation } from "./arrangement-mutation";
import type { ArrangeAction } from "../commands/arrange";
import { prepareAppendMutation } from "./append-mutation";
import type { InkElementV1 } from "../schema/public";
import {
  captureOwnedMutationHistory,
  STABLE_RELATIVE_ORDER,
  type OwnedMutationHistory,
  type OwnedMutationReplay,
} from "./owned-mutation-history";
import type {
  AppliedElementMutation,
  ElementMutation,
  ElementRank,
  ElementMutationCommitResult,
  PreparedElementMutation,
  PreparedElementMutationResult,
  StoreSliceScheduler,
  StoreDelta,
} from "./types";

interface VersionedMutationSource extends MutationSource {
  readonly mutationVersion: number;
  readonly ranks: ReadonlyMap<string, ElementRank>;
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
  readonly #trustedReplayVersions = new WeakMap<ElementMutation, number>();
  readonly #trustedOrders = new WeakMap<
    ElementMutation,
    {
      readonly mutationVersion: number;
      readonly order: MutationOrder;
    }
  >();

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

  public prepare(
    mutation: ElementMutation,
    scheduler: StoreSliceScheduler,
    replay?: AppliedElementMutation,
  ): Promise<PreparedElementMutationResult> {
    return this.#prepare(mutation, scheduler, replay);
  }

  public async prepareArrangement(
    action: ArrangeAction,
    selection: ReadonlySet<string>,
    scheduler: StoreSliceScheduler,
  ): Promise<PreparedElementMutationResult> {
    const source = this.#readSource();
    const prepared = await prepareArrangementMutation(
      { bands: source.bands, ranks: source.ranks },
      action,
      selection,
      {
        ...scheduler,
        isCancelled: () =>
          source.mutationVersion !== this.#readVersion() || (scheduler.isCancelled?.() ?? false),
      },
    );
    return this.#prepareTrustedOrder(prepared, source.mutationVersion, scheduler);
  }

  public async prepareAppend(
    elements: readonly InkElementV1[],
    scheduler: StoreSliceScheduler,
  ): Promise<PreparedElementMutationResult> {
    const source = this.#readSource();
    const prepared = await prepareAppendMutation(source, elements, {
      ...scheduler,
      isCancelled: () =>
        source.mutationVersion !== this.#readVersion() || (scheduler.isCancelled?.() ?? false),
    });
    return this.#prepareTrustedOrder(prepared, source.mutationVersion, scheduler);
  }

  #prepareTrustedOrder(
    prepared:
      { readonly mutation: ElementMutation; readonly order: MutationOrder } | "cancelled" | null,
    mutationVersion: number,
    scheduler: StoreSliceScheduler,
  ): Promise<PreparedElementMutationResult> {
    if (
      prepared === "cancelled" ||
      mutationVersion !== this.#readVersion() ||
      scheduler.isCancelled?.()
    )
      return Promise.resolve({ status: "cancelled", token: null });
    if (prepared === null) return Promise.resolve({ status: "noop", token: null });
    this.#trustedOrders.set(prepared.mutation, {
      mutationVersion,
      order: prepared.order,
    });
    return this.#prepare(prepared.mutation, scheduler);
  }

  /** Only transitions retained by this store can select private canonical replay values. */
  public prepareHistoryReplay(
    mutation: ElementMutation,
    scheduler: StoreSliceScheduler,
    replay: AppliedElementMutation,
  ): Promise<PreparedElementMutationResult> {
    return this.#prepare(mutation, scheduler, replay, true);
  }

  async #prepare(
    mutation: ElementMutation,
    scheduler: StoreSliceScheduler,
    replay?: AppliedElementMutation,
    retained = false,
  ): Promise<PreparedElementMutationResult> {
    const source = this.#readSource();
    const work = {
      isCancelled: () =>
        source.mutationVersion !== this.#readVersion() || (scheduler.isCancelled?.() ?? false),
      shouldYield: scheduler.shouldYield,
      yieldControl: scheduler.yieldControl,
    };
    let proof = this.#replayProof(mutation, replay, source.mutationVersion);
    if (retained) {
      if (proof === undefined || replay === undefined) {
        throw new RangeError("History transition is not retained by this store.");
      }
      const pendingMutation = new MutationPreparationScheduler(work).run(
        ownedHistoryReplaySteps(mutation, replay, proof.history, source.records),
      );
      const retainedMutation =
        pendingMutation instanceof Promise ? await pendingMutation : pendingMutation;
      if (retainedMutation === "cancelled") return { status: "cancelled", token: null };
      proof = { ...proof, retainedMutation };
    }
    const plan = await planElementMutation(source, mutation, work, replay, {
      trustedRemoval:
        replay === undefined &&
        this.#trustedRemovalVersions.get(mutation) === source.mutationVersion,
      ...(proof === undefined ? {} : { ownedReplay: proof }),
      ...(this.#trustedOrders.get(mutation)?.mutationVersion === source.mutationVersion
        ? { trustedOrder: this.#trustedOrders.get(mutation)!.order }
        : {}),
    });
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
      this.#trustNextDirection(result.transition, prepared.plan.requested);
    }
    return result;
  }

  public retainRemoval(
    delta: StoreDelta,
    beforeBands: ElementMutation["bands"],
    afterBands: ElementMutation["bands"],
  ): AppliedElementMutation {
    const transition = createRemovalTransition(delta, beforeBands, afterBands);
    const owned = captureOwnedMutationHistory(delta, STABLE_RELATIVE_ORDER);
    const retained = Object.freeze({
      ...transition,
      payloadBytes: transition.payloadBytes + owned.payloadBytes,
    });
    this.#ownedHistory.set(retained, owned);
    this.#trustNextDirection(retained, retained.forward);
    return retained;
  }

  #replayProof(
    mutation: ElementMutation,
    replay: AppliedElementMutation | undefined,
    version: number,
  ): OwnedMutationReplay | undefined {
    if (replay === undefined) return undefined;
    const history = this.#ownedHistory.get(replay);
    if (history === undefined) return undefined;
    return { history, bandsTrusted: this.#trustedReplayVersions.get(mutation) === version };
  }

  #trustNextDirection(transition: AppliedElementMutation, requested: ElementMutation): void {
    this.#trustedReplayVersions.delete(transition.forward);
    this.#trustedReplayVersions.delete(transition.reverse);
    const next = requested === transition.reverse ? transition.forward : transition.reverse;
    this.#trustedReplayVersions.set(next, this.#readVersion());
  }
}
