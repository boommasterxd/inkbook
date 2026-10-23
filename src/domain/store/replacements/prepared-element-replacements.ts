import type { InkElementV1 } from "../../schema/public";

import type {
  ElementReplacementPlan,
  ElementReplacementSource,
  PreparedReplacementState,
} from "./replacement-types";
import { planElementReplacement } from "./time-sliced-element-replacement";
import type {
  ElementReplacementCommitResult,
  PreparedElementReplacement,
  PreparedElementReplacementResult,
  StoreSliceScheduler,
} from "../types";

interface VersionedReplacementSource extends ElementReplacementSource {
  readonly mutationVersion: number;
}

export class PreparedElementReplacements {
  readonly #source: () => VersionedReplacementSource;
  readonly #readVersion: () => number;
  readonly #onPrepared: (plan: ElementReplacementPlan) => void;
  readonly #onCommit: (plan: ElementReplacementPlan) => ElementReplacementCommitResult;
  readonly #prepared = new WeakMap<PreparedElementReplacement, PreparedReplacementState>();

  public constructor(
    source: () => VersionedReplacementSource,
    readVersion: () => number,
    onPrepared: (plan: ElementReplacementPlan) => void,
    onCommit: (plan: ElementReplacementPlan) => ElementReplacementCommitResult,
  ) {
    this.#source = source;
    this.#readVersion = readVersion;
    this.#onPrepared = onPrepared;
    this.#onCommit = onCommit;
  }

  public async prepare(
    replacements: readonly InkElementV1[],
    scheduler: StoreSliceScheduler,
  ): Promise<PreparedElementReplacementResult> {
    if (replacements.length === 0) return { status: "noop", token: null };
    const source = this.#source();
    const mutationVersion = source.mutationVersion;
    const isCancelled = () =>
      this.#readVersion() !== mutationVersion || (scheduler.isCancelled?.() ?? false);
    const plan = await planElementReplacement(source, replacements, {
      isCancelled,
      shouldYield: scheduler.shouldYield,
      yieldControl: scheduler.yieldControl,
    });
    if (plan === "cancelled" || this.#readVersion() !== mutationVersion) {
      return { status: "cancelled", token: null };
    }
    if (plan === null) return { status: "noop", token: null };
    const token = Object.freeze({}) as PreparedElementReplacement;
    this.#prepared.set(token, { isCancelled, mutationVersion, plan });
    this.#onPrepared(plan);
    return { status: "prepared", token, historyPayloadBytes: plan.history.payloadBytes };
  }

  public commit(token: PreparedElementReplacement): ElementReplacementCommitResult {
    const prepared = this.#prepared.get(token);
    this.#prepared.delete(token);
    if (
      prepared === undefined ||
      prepared.isCancelled() ||
      this.#readVersion() !== prepared.mutationVersion
    ) {
      return { delta: null, status: "cancelled", history: null };
    }
    return this.#onCommit(prepared.plan);
  }
}
