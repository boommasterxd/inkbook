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
    const appendResults = new Array<string>(
      Math.ceil(fixture.elements.length / MAX_UNLOCK_BATCH_ELEMENTS),
    );
    const started = performance.now();
    for (let start = 0; start < fixture.elements.length; start += MAX_UNLOCK_BATCH_ELEMENTS) {
      const end = start + MAX_UNLOCK_BATCH_ELEMENTS;
      appendResults[start / MAX_UNLOCK_BATCH_ELEMENTS] = await builder.appendOwnedValidatedRuntime(
        fixture.elements.slice(start, end),
        validation.derivations.elements.slice(start, end),
      );
    }
    const hydrated = await builder.finalize();
    const duration = performance.now() - started;
    scheduler.finish();
    for (const result of appendResults) expect(result).toBe("accepted");

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

  it.each([65, 11_000])(
    "forces bounded hydration yields for %i records without deadline pressure",
    async (count) => {
      const elements = createStandardRuntimeDomainFixture().elements.slice(0, count);
      const validation = validateRuntimeInkSnapshotV1(createWorkerSnapshot([...elements]));
      if (!validation.ok) throw new Error("The counted hydration fixture is invalid.");
      const visited: number[] = [];
      const sliceVisits: number[] = [];
      let pendingVisits = 0;
      const counted = new Proxy(elements, {
        get(target, key, receiver): unknown {
          if (typeof key === "string" && /^(0|[1-9]\d*)$/u.test(key)) {
            pendingVisits += 1;
            visited.push(Number(key));
          }
          return Reflect.get(target, key, receiver);
        },
      });
      const builder = ElementStore.createBuilder({
        shouldYield: () => false,
        yieldControl: async () => {
          sliceVisits.push(pendingVisits);
          pendingVisits = 0;
        },
      });

      const appendResult = await builder.appendOwnedValidatedRuntime(
        counted,
        validation.derivations.elements,
      );
      expect(appendResult).toBe("accepted");
      expect(visited).toEqual(Array.from({ length: count }, (_, index) => index));
      expect(sliceVisits).toHaveLength(Math.floor(count / 64));
      for (const visits of sliceVisits) expect(visits).toBe(64);
      expect(pendingVisits).toBe(count % 64);
      expect(sliceVisits.reduce((total, visits) => total + visits, pendingVisits)).toBe(count);

      const hydrated = await builder.finalize();
      expect(hydrated?.size).toBe(count);
      expect(hydrated?.instrumentation).toMatchObject({
        hydrationElementVisits: count * 2,
        publishedDeltas: 0,
      });
      for (const element of elements) expect(hydrated?.get(element.id)).toBeDefined();
    },
  );
});
