import { copyRuntimeElementSteps } from "../elements/runtime-element-copy";
import { validateRuntimeReplacementSteps } from "../elements/runtime-replacement-validation";
import type { InkElementV1 } from "../schema/public";
import { takeImmutableElementOwnership } from "./immutability";
import type { MutationPreparationScheduler } from "./mutation-preparation-scheduler";
import type { ElementRecord } from "./types";

/** Validate the same privately staged values that record preparation will adopt. */
export async function prepareRuntimeElement(
  element: InkElementV1,
  current: ElementRecord | undefined,
  retained: ElementRecord | undefined,
  scheduler: MutationPreparationScheduler,
): Promise<InkElementV1 | "cancelled"> {
  const owned = retained ?? current;
  const points = owned?.element.kind === "stroke" ? owned.element.points : undefined;
  let staged: InkElementV1 | "cancelled";
  try {
    staged = await scheduler.run(copyRuntimeElementSteps(element, points));
  } catch (error: unknown) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new RangeError("Invalid runtime element staging.");
    }
    throw error;
  }
  if (staged === "cancelled") return staged;
  const validation = await scheduler.run(
    validateRuntimeReplacementSteps(owned?.element ?? {}, staged),
  );
  if (validation === "cancelled") return validation;
  if (!validation.ok) throw new RangeError(`Invalid runtime element: ${validation.error.code}`);
  return takeImmutableElementOwnership(staged) as InkElementV1;
}
