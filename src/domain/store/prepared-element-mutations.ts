import {
  planElementMutation,
  type ElementMutationPlan,
  type MutationSource,
} from "./element-mutation";
import type {
  AppliedElementMutation,
  ElementMutation,
  ElementMutationCommitResult,
  PreparedElementMutation,
  PreparedElementMutationResult,
  StoreSliceScheduler,
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

  public constructor(
    readSource: () => VersionedMutationSource,
    readVersion: () => number,
    adopt: (plan: ElementMutationPlan) => ElementMutationCommitResult,
  ) {
    this.#readSource = readSource;
    this.#readVersion = readVersion;
    this.#adopt = adopt;
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
    return this.#adopt(prepared.plan);
  }
}
