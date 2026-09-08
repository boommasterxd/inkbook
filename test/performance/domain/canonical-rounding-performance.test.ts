import { describe, expect, it } from "vitest";

import { canonicalizeGeometryNumber } from "../../../src/domain/schema/canonical";
import { interactionP99, INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { timingBudget } from "../timing-budget";

describe("canonical coordinate rounding", () => {
  it("rounds every coordinate of a maximum stroke within the frame budget", async ({
    annotate,
  }) => {
    const coordinates = Array.from({ length: 4096 * 2 }, (_, index) => index * 0.731 - 1999.781);
    const durations: number[] = [];
    let checksum = 0;
    for (let frame = 0; frame < 600; frame += 1) {
      const factor = 0.53 + frame * 0.000137;
      const started = performance.now();
      for (const value of coordinates) checksum += canonicalizeGeometryNumber(value * factor);
      durations.push(performance.now() - started);
    }
    const p99 = interactionP99(durations);
    expect(Number.isFinite(checksum)).toBe(true);
    expect(p99).toBeLessThanOrEqual(timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms));
    await annotate(`Maximum-stroke coordinate rounding p99=${p99.toFixed(3)} ms`, "performance");
  });
});
