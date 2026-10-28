import { vi } from "vitest";

import { CanonicalElementPathPreparation } from "../../../src/domain/geometry/canonical-element-path-preparation";

/** Observes real canonical steps while each caller owns its simulated scheduling cost. */
export function observePathPreparationSteps(afterStep: () => void) {
  const prepare = Reflect.get<CanonicalElementPathPreparation, "step">(
    CanonicalElementPathPreparation.prototype,
    "step",
  );
  return vi.spyOn(CanonicalElementPathPreparation.prototype, "step").mockImplementation(function (
    this: CanonicalElementPathPreparation,
    deadline,
    now,
  ) {
    const completed = prepare.call(this, deadline, now);
    afterStep();
    return completed;
  });
}
