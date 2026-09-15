import { describe, expect, it } from "vitest";

import { validateRuntimeInkSnapshotV1 } from "../../../src/domain/schema/snapshot-validation";
import { ElementStore } from "../../../src/domain/store/public";
import { MAX_UNLOCK_BATCH_ELEMENTS } from "../../../src/persistence/worker/runtime/unlock-batch-limits";

import { createWorkerSnapshot } from "../../fixtures/persistence/worker-snapshot";
import { MeasuredSliceScheduler, percentile } from "./domain-scenarios";
import { createStandardRuntimeDomainFixture } from "./standard-domain-fixture";
import { INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { expectTiming } from "../timing-assertions";

describe("runtime store hydration performance", () => {
  it("builds a complete initial store in cancellable bounded slices", async ({ annotate }) => {
    const fixture = createStandardRuntimeDomainFixture();
    const validation = validateRuntimeInkSnapshotV1(createWorkerSnapshot([...fixture.elements]));
    if (!validation.ok) {
      throw new Error(`Runtime hydration fixture is invalid: ${validation.error.code}`);
    }
    const scheduler = new MeasuredSliceScheduler(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    const builder = ElementStore.createBuilder(scheduler);
    const started = performance.now();
    for (let start = 0; start < fixture.elements.length; start += MAX_UNLOCK_BATCH_ELEMENTS) {
      const end = start + MAX_UNLOCK_BATCH_ELEMENTS;
      expect(
        await builder.appendOwnedValidatedRuntime(
          fixture.elements.slice(start, end),
          validation.derivations.elements.slice(start, end),
        ),
      ).toBe("accepted");
    }
    const hydrated = await builder.finalize();
    const duration = performance.now() - started;
    scheduler.finish();

    expect(hydrated?.size).toBe(11_000);
    expect(hydrated?.instrumentation).toMatchObject({
      hydrationElementVisits: 22_000,
      publishedDeltas: 0,
    });
    expectTiming(duration, 750);
    expect(scheduler.sliceDurations.length).toBeGreaterThanOrEqual(100);
    expectTiming(
      percentile(scheduler.sliceDurations, 0.95),
      INTERACTION_REFRESH_PROFILE.mainThreadP99Ms,
    );
    expectTiming(scheduler.maxSliceDuration, INTERACTION_REFRESH_PROFILE.atomicCommitMaxMs);
    await annotate(
      `validated hydration: refreshRate=${INTERACTION_REFRESH_PROFILE.refreshRate} Hz, ` +
        `maxSlice=${scheduler.maxSliceDuration.toFixed(3)} ms, total=${duration.toFixed(3)} ms`,
      "performance",
    );
  });
});
