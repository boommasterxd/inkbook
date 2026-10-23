import {
  planElementMutation,
  type ElementMutationPlan,
  type MutationSource,
} from "./element-mutation";
import { prepareRemovalMutation } from "./removal-mutation";
import { createRemovalTransition } from "./removal-transition";
import { ownedHistoryReplaySteps } from "./owned-history-replay";
import { MutationPreparationScheduler } from "./mutation-preparation-scheduler";
import { isRetainedMutationDirection } from "./mutation-history";
import type { MutationOrder } from "./mutation-order";
import { prepareArrangementMutation } from "./arrangement-mutation";
import type { ArrangeAction } from "../../commands/arrange";
import { prepareAppendMutation } from "./append-mutation";
import { HistoryBandStates, type HistoryBandState } from "./history-band-state";
import type { InkElementV1 } from "../../schema/public";
import {
  captureOwnedMutationHistory,
  STABLE_RELATIVE_ORDER,
  type OwnedMutationHistory,
  type OwnedMutationReplay,
} from "./owned-mutation-history";
import type {
  AppliedElementMutation,
  AppliedRemovalResult,
  ElementMutation,
  ElementRank,
  ElementMutationCommitResult,
  PreparedElementMutation,
  PreparedElementMutationResult,
  StoreSliceScheduler,
  StoreDelta,
} from "../types";

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
  readonly #bandStates = new HistoryBandStates();
  readonly #retainedReplays = new WeakSet<ElementMutationPlan>();
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
    const prepared = await prepareRemovalMutation(ids, source, {
      isCancelled: () =>
        source.mutationVersion !== this.#readVersion() || (scheduler.isCancelled?.() ?? false),
      shouldYield: scheduler.shouldYield,
      yieldControl: scheduler.yieldControl,
    });
    if (source.mutationVersion !== this.#readVersion() || scheduler.isCancelled?.())
      return "cancelled";
    if (prepared === null || prepared === "cancelled") return prepared;
    this.#trustedRemovalVersions.set(prepared.mutation, source.mutationVersion);
    this.#trustedOrders.set(prepared.mutation, {
      mutationVersion: source.mutationVersion,
      order: prepared.order,
    });
    return prepared.mutation;
  }

  public prepare(
    mutation: ElementMutation,
    scheduler: StoreSliceScheduler,
    replay?: AppliedElementMutation,
  ): Promise<PreparedElementMutationResult> {
    if (isRetainedMutationDirection(mutation)) {
      throw new RangeError("Opaque history directions require prepareHistoryReplay.");
    }
    return this.#prepare(mutation, scheduler, replay);
  }

  /** Retain canonical records without exposing duplicate mutable sample payloads. */
  public async prepareElementRemoval(
    ids: ReadonlySet<string> | readonly string[],
    scheduler: StoreSliceScheduler,
  ): Promise<PreparedElementMutationResult> {
    const version = this.#readVersion();
    const mutation = await this.createRemovalMutationTimeSliced(ids, scheduler);
    if (mutation === "cancelled" || version !== this.#readVersion() || scheduler.isCancelled?.()) {
      return { status: "cancelled", token: null };
    }
    if (mutation === null) return { status: "noop", token: null };
    return this.#prepare(mutation, scheduler, undefined, false, true);
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
    retainedOnly = false,
  ): Promise<PreparedElementMutationResult> {
    const source = this.#readSource();
    const work = {
      isCancelled: () =>
        source.mutationVersion !== this.#readVersion() || (scheduler.isCancelled?.() ?? false),
      shouldYield: scheduler.shouldYield,
      yieldControl: scheduler.yieldControl,
    };
    let proof = this.#replayProof(mutation, replay);
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
    let plan: ElementMutationPlan | "cancelled" | null;
    try {
      plan = await planElementMutation(source, mutation, work, replay, {
        retainedOnly,
        trustedRemoval:
          replay === undefined &&
          this.#trustedRemovalVersions.get(mutation) === source.mutationVersion,
        ...(proof === undefined ? {} : { ownedReplay: proof }),
        ...(this.#trustedOrders.get(mutation)?.mutationVersion === source.mutationVersion
          ? { trustedOrder: this.#trustedOrders.get(mutation)!.order }
          : {}),
      });
    } finally {
      // Removal's public direction can live in history. Only prepared tokens own
      // the staged mutable band and rank arrays after this handoff.
      this.#trustedOrders.delete(mutation);
    }
    if (
      plan === "cancelled" ||
      source.mutationVersion !== this.#readVersion() ||
      scheduler.isCancelled?.()
    ) {
      return { status: "cancelled", token: null };
    }
    if (plan === null) return { status: "noop", token: null };
    if (retained) this.#retainedReplays.add(plan);
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
    return this.#adopt(prepared.plan);
  }

  public removeWithHistory(
    remove: (beforeNotify: (delta: StoreDelta) => void) => void,
  ): AppliedRemovalResult | null {
    const source = this.#readSource();
    const beforeState = this.#bandStates.capture();
    const beforeBands = {
      content: [...source.bands.content],
      highlight: [...source.bands.highlight],
    };
    let result: AppliedRemovalResult | null = null;
    remove((delta) => {
      const transition = this.#retainRemoval(delta, beforeBands, source.bands, beforeState);
      result = Object.freeze({ delta, transition });
    });
    return result;
  }

  public publish(delta: StoreDelta, plan?: ElementMutationPlan): void {
    if (plan?.ownedHistory === undefined) {
      this.#bandStates.publish(delta);
      return;
    }
    this.#ownedHistory.set(plan.applied, plan.ownedHistory);
    this.#bandStates.publish(
      delta,
      plan.applied,
      this.#retainedReplays.has(plan) ? plan.requested : undefined,
    );
  }

  #retainRemoval(
    delta: StoreDelta,
    beforeBands: ElementMutation["bands"],
    afterBands: ElementMutation["bands"],
    beforeState: HistoryBandState,
  ): AppliedElementMutation {
    const transition = createRemovalTransition(delta, beforeBands, afterBands);
    const owned = captureOwnedMutationHistory(delta, STABLE_RELATIVE_ORDER);
    const retained = Object.freeze({
      ...transition,
      payloadBytes: transition.payloadBytes + owned.payloadBytes,
    });
    this.#ownedHistory.set(retained, owned);
    this.#bandStates.retain(retained, beforeState);
    return retained;
  }

  #replayProof(
    mutation: ElementMutation,
    replay: AppliedElementMutation | undefined,
  ): OwnedMutationReplay | undefined {
    if (replay === undefined) return undefined;
    const history = this.#ownedHistory.get(replay);
    if (history === undefined) return undefined;
    return { history, bandsTrusted: this.#bandStates.trusts(mutation, replay) };
  }
}
