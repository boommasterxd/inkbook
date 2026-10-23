import type { InkElementV1 } from "../../schema/public";
import { prepareReplacementPlan, type ReplacementPlan } from "./replacement-plan";
import type { ReplacementCandidate, ReplacementPlannerPorts } from "./replacement-planner";

interface OwnedReplacementPlan {
  readonly mutationVersion: number;
  readonly candidates: readonly ReplacementCandidate[];
  consumed: boolean;
}

/** Validated immutable candidates may be consumed once by their owning Store revision. */
export class SynchronousReplacementPlans {
  readonly #plans = new WeakMap<readonly InkElementV1[], OwnedReplacementPlan>();
  readonly #ports: () => ReplacementPlannerPorts;
  readonly #version: () => number;

  public constructor(ports: () => ReplacementPlannerPorts, version: () => number) {
    this.#ports = ports;
    this.#version = version;
  }

  public plan(replacements: readonly InkElementV1[]): ReplacementPlan | null {
    if (replacements.length === 0) return null;
    const mutationVersion = this.#version();
    const plan = prepareReplacementPlan(replacements, this.#ports());
    if (mutationVersion !== this.#version()) throw new RangeError("Replacement plan is stale.");
    if (plan.elements.length === 0) return null;
    const owned = {
      candidates: plan.candidates,
      consumed: false,
      mutationVersion,
    };
    this.#plans.set(plan.elements, owned);
    this.#plans.set(plan.replacements, owned);
    return { elements: plan.elements, replacements: plan.replacements, yields: plan.yields };
  }

  public consume(
    replacements: readonly InkElementV1[],
  ): readonly ReplacementCandidate[] | undefined {
    const plan = this.#plans.get(replacements);
    this.#plans.delete(replacements);
    if (plan === undefined) return undefined;
    if (plan.consumed || plan.mutationVersion !== this.#version()) {
      throw new RangeError("Replacement plan is stale.");
    }
    plan.consumed = true;
    return plan.candidates;
  }
}
