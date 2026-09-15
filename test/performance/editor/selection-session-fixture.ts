import { PASS_THROUGH_PLANNER } from "./selection-input-fixture";
import type { InkElementV1, PointV1 } from "../../../src/domain/schema/public";
import { SelectionHandleSession } from "../../../src/editor/selection/public";

export function createPassThroughMoveSession(
  elements: readonly InkElementV1[],
  startPointer: PointV1,
): SelectionHandleSession {
  return new SelectionHandleSession({
    action: { kind: "move" },
    elements,
    planner: PASS_THROUGH_PLANNER,
    startPointer,
  });
}
