import { planCompactMutation } from "./compact-mutation";
import { expandCompactMutation } from "./compact-mutation-order";
import type { CompactMutationPlan, CompactMutationSource } from "./compact-mutation-types";
import { planElementMutation, type ElementMutationPlan } from "./element-mutation";
import type {
  ElementMutation,
  ElementMutationCommitResult,
  PreparedElementMutation,
  PreparedElementMutationResult,
  StoreSliceScheduler,
} from "./types";

export type PreparedMutationPlan = ElementMutationPlan | CompactMutationPlan;

interface VersionedMutationSource extends CompactMutationSource {
  readonly mutationVersion: number;
}

export class PreparedElementMutations {
  readonly #adopt: (plan: PreparedMutationPlan) => ElementMutationCommitResult;
  readonly #prepared = new WeakMap<
    PreparedElementMutation,
    {
      readonly isCancelled: () => boolean;
      readonly mutationVersion: number;
      readonly plan: PreparedMutationPlan;
    }
  >();
  readonly #readVersion: () => number;
  readonly #readSource: () => VersionedMutationSource;

  public constructor(
    readSource: () => VersionedMutationSource,
    adopt: (plan: PreparedMutationPlan) => ElementMutationCommitResult,
    readVersion: () => number,
  ) {
    this.#readSource = readSource;
    this.#adopt = adopt;
    this.#readVersion = readVersion;
  }

  public async prepare(
    mutation: ElementMutation,
    scheduler: StoreSliceScheduler,
  ): Promise<PreparedElementMutationResult> {
    const source = this.#readSource();
    const guardedScheduler = {
      isCancelled: () =>
        source.mutationVersion !== this.#readVersion() || (scheduler.isCancelled?.() ?? false),
      shouldYield: scheduler.shouldYield,
      yieldControl: scheduler.yieldControl,
    };
    let plan =
      mutation.bands === undefined
        ? await planCompactMutation(source, mutation, guardedScheduler)
        : await planElementMutation(source, mutation, guardedScheduler);
    if (plan === "fallback") {
      const expanded = await expandCompactMutation(source, mutation, guardedScheduler);
      plan =
        expanded === "cancelled"
          ? expanded
          : await planElementMutation(expanded.source, expanded.mutation, guardedScheduler);
    }
    if (plan === "cancelled" || guardedScheduler.isCancelled()) {
      return { status: "cancelled", token: null };
    }
    if (plan === null) return { status: "noop", token: null };
    const token = Object.freeze({}) as PreparedElementMutation;
    this.#prepared.set(token, {
      isCancelled: guardedScheduler.isCancelled,
      mutationVersion: source.mutationVersion,
      plan,
    });
    return { status: "prepared", token };
  }

  public commit(token: PreparedElementMutation): ElementMutationCommitResult {
    const prepared = this.#prepared.get(token);
    this.#prepared.delete(token);
    if (
      prepared === undefined ||
      prepared.isCancelled() ||
      prepared.mutationVersion !== this.#readVersion()
    ) {
      return { delta: null, status: "cancelled", transition: null };
    }
    return this.#adopt(prepared.plan);
  }
}
