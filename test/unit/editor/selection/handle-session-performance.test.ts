import { describe, expect, it } from "vitest";

import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { SelectionHandleSession } from "../../../../src/editor/selection/public";
import { rectangle } from "../../domain/store/fixtures";

function replacementPlan(replacements: readonly InkElementV1[]) {
  return { elements: replacements, replacements };
}

describe("SelectionHandleSession performance contracts", () => {
  it("reuses the gesture-start scale minimum during time-sliced pointer commits", async () => {
    const shapes = Array.from({ length: 1_001 }, (_, index) =>
      rectangle(`00000000-0000-4000-8001-${index.toString().padStart(12, "0")}`, index * 250, 0),
    );
    const session = new SelectionHandleSession({
      action: { anchor: { x: 0, y: 0 }, kind: "scale", position: "bottom-right" },
      elements: shapes,
      planner: {
        countReverseDependencies: () => 0,
        planReplacements: replacementPlan,
        planReplacementsTimeSliced: async (replacements) => replacementPlan(replacements),
      },
      startPointer: { x: 1_000, y: 0 },
    });
    session.update({ x: 500, y: 0 });
    let yields = 0;

    const prepared = await session.prepareCommitTimeSliced({
      shouldYield: () => true,
      yieldControl: async () => {
        yields += 1;
      },
    });

    expect(prepared.status).toBe("ready");
    expect(yields).toBe(shapes.length);
  });
});
