import { describe, expect, it, vi } from "vitest";

import { validateRuntimeInkSnapshotV1 } from "../../../src/domain/schema/snapshot-validation";
import { ElementStore } from "../../../src/domain/store/public";
import { UniformSpatialIndex } from "../../../src/domain/spatial/index";
import { MAX_UNLOCK_BATCH_ELEMENTS } from "../../../src/persistence/worker/runtime/wire/unlock-batch-limits";

import { createWorkerSnapshot } from "../../fixtures/persistence/worker-snapshot";
import { CheckpointSliceScheduler } from "./domain-scenarios";
import { createStandardRuntimeDomainFixture } from "./standard-domain-fixture";

describe("runtime store hydration performance", () => {
  it("builds a complete initial store in cancellable bounded slices", async () => {
    const fixture = createStandardRuntimeDomainFixture();
    const validation = validateRuntimeInkSnapshotV1(createWorkerSnapshot([...fixture.elements]));
    if (!validation.ok) {
      throw new Error(`Runtime hydration fixture is invalid: ${validation.error.code}`);
    }
    const scheduler = new CheckpointSliceScheduler(40);
    const builder = ElementStore.createBuilder(scheduler);
    const appendResults = new Array<string>(
      Math.ceil(fixture.elements.length / MAX_UNLOCK_BATCH_ELEMENTS),
    );
    for (let start = 0; start < fixture.elements.length; start += MAX_UNLOCK_BATCH_ELEMENTS) {
      const end = start + MAX_UNLOCK_BATCH_ELEMENTS;
      appendResults[start / MAX_UNLOCK_BATCH_ELEMENTS] = await builder.appendOwnedValidatedRuntime(
        fixture.elements.slice(start, end),
        validation.derivations.elements.slice(start, end),
      );
    }
    const hydrated = await builder.finalize();
    scheduler.finish();
    for (const result of appendResults) expect(result).toBe("accepted");

    expect(hydrated?.size).toBe(11_000);
    expect(hydrated?.instrumentation).toMatchObject({
      hydrationElementVisits: 22_000,
      publishedDeltas: 0,
    });
    expect(scheduler.checkpointCounts.length).toBeGreaterThan(1);
    expect(scheduler.checkpointCounts.every((count) => count <= 40)).toBe(true);
  });
});

describe("validated hydration clock probes", () => {
  it.each([65, 11_000])(
    "uses remaining shared budget for %i records without forced hydration yields",
    async (count) => {
      const elements = createStandardRuntimeDomainFixture().elements.slice(0, count);
      const validation = validateRuntimeInkSnapshotV1(createWorkerSnapshot([...elements]));
      if (!validation.ok) throw new Error("The counted hydration fixture is invalid.");
      const visited: number[] = [];
      const sliceVisits: number[] = [];
      let pendingVisits = 0;
      let visitsSinceClock = 0;
      const clockVisits: number[] = [];
      const counted = new Proxy(elements, {
        get(target, key, receiver): unknown {
          if (typeof key === "string" && /^(0|[1-9]\d*)$/u.test(key)) {
            pendingVisits += 1;
            visitsSinceClock += 1;
            visited.push(Number(key));
          }
          return Reflect.get(target, key, receiver);
        },
      });
      const builder = ElementStore.createBuilder({
        shouldYield: () => {
          clockVisits.push(visitsSinceClock);
          visitsSinceClock = 0;
          return false;
        },
        yieldControl: async () => {
          sliceVisits.push(pendingVisits);
          pendingVisits = 0;
        },
      });
      const commits = vi.spyOn(UniformSpatialIndex.prototype, "insertMany");
      try {
        const appendResult = await builder.appendOwnedValidatedRuntime(
          counted,
          validation.derivations.elements,
        );
        expect(appendResult).toBe("accepted");
        expect(visited).toEqual(Array.from({ length: count }, (_, index) => index));
        expect(sliceVisits).toHaveLength(0);
        expect(pendingVisits).toBe(count);
        expect(sliceVisits.reduce((total, visits) => total + visits, pendingVisits)).toBe(count);
        expect(clockVisits).toHaveLength(Math.ceil(count / 8));
        expect(clockVisits.every((visits) => visits > 0 && visits <= 8)).toBe(true);
        expect(commits.mock.calls.map(([entries]) => entries.length)).toEqual(
          Array.from({ length: Math.ceil(count / 64) }, (_, index) =>
            Math.min(64, count - index * 64),
          ),
        );

        const hydrated = await builder.finalize();
        expect(hydrated?.size).toBe(count);
        expect(hydrated?.instrumentation).toMatchObject({
          hydrationElementVisits: count * 2,
          publishedDeltas: 0,
        });
        for (const element of elements) expect(hydrated?.get(element.id)?.element).toBe(element);
      } finally {
        commits.mockRestore();
      }
    },
  );
});
