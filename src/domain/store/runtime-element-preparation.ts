import { copyRuntimeElementSteps } from "../elements/runtime-element-copy";
import { validateRuntimeReplacementSteps } from "../elements/runtime-replacement-validation";
import type { InkElementV1 } from "../schema/public";
import { takeImmutableElementOwnership } from "./immutability";
import type { MutationPreparationScheduler } from "./mutation-preparation-scheduler";
import type { ElementRecord } from "./types";

/** Validate the same privately staged values that record preparation will adopt. */
export function prepareRuntimeElement(
  element: InkElementV1,
  current: ElementRecord | undefined,
  retained: ElementRecord | undefined,
  scheduler: MutationPreparationScheduler,
): InkElementV1 | "cancelled" | Promise<InkElementV1 | "cancelled"> {
  const owned = retained ?? current;
  const points = owned?.element.kind === "stroke" ? owned.element.points : undefined;
  const phase = { copying: true };
  try {
    const copy = copyRuntimeElementSteps(element, points);
    const prepared = scheduler.run(prepareRuntimeElementSteps(copy, owned, phase));
    return prepared instanceof Promise
      ? prepared.catch((error: unknown) => rethrowPreparationError(error, phase.copying))
      : prepared;
  } catch (error: unknown) {
    return rethrowPreparationError(error, phase.copying);
  }
}

function* prepareRuntimeElementSteps(
  copy: Generator<void, InkElementV1>,
  owned: ElementRecord | undefined,
  phase: { copying: boolean },
): Generator<void | boolean, InkElementV1> {
  const staged = yield* copy;
  phase.copying = false;
  // Preserve the shared-deadline checkpoint between staging and validation.
  yield;
  const validation = yield* validateRuntimeReplacementSteps(owned?.element ?? {}, staged);
  if (!validation.ok) throw new RangeError(`Invalid runtime element: ${validation.error.code}`);
  return takeImmutableElementOwnership(staged) as InkElementV1;
}

function rethrowPreparationError(error: unknown, copying: boolean): never {
  if (copying && (error instanceof TypeError || error instanceof RangeError)) {
    throw new RangeError("Invalid runtime element staging.");
  }
  throw error;
}
