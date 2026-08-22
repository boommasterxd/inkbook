import { expect, it } from "vitest";

import {
  ElementStore,
  type AppliedElementMutation,
  type ElementMutation,
} from "../../../src/domain/store/public";

import { MeasuredSliceScheduler } from "./domain-scenarios";
import { createStandardDomainFixture } from "./standard-domain-fixture";

interface MutationMeasurement {
  readonly commitDuration: number;
  readonly maximumSlice: number;
  readonly preparationDuration: number;
  readonly transition: AppliedElementMutation;
}

it("keeps atomic clipboard-scale store adoption within main-thread slice budgets", async ({
  annotate,
}) => {
  const fixture = createStandardDomainFixture();
  const store = new ElementStore(fixture.elements);
  const removed = new Set(fixture.strokeIds);
  const cut: ElementMutation = {
    bands: {
      content: remainingBand(store, "content", removed),
      highlight: remainingBand(store, "highlight", removed),
    },
    removeIds: fixture.strokeIds,
  };

  const warmCut = await measureMutation(store, cut, 11_000);
  await measureMutation(store, warmCut.transition.reverse, 1_000);
  const cuts: MutationMeasurement[] = [];
  const restores: MutationMeasurement[] = [];
  for (let run = 0; run < 5; run += 1) {
    const measuredCut = await measureMutation(store, cut, 11_000);
    cuts.push(measuredCut);
    restores.push(await measureMutation(store, measuredCut.transition.reverse, 1_000));
  }

  const maximumSlice = maximum([...cuts, ...restores].map(({ maximumSlice }) => maximumSlice));
  const maximumCommit = maximum([...cuts, ...restores].map(({ commitDuration }) => commitDuration));
  const maximumCut = maximum(cuts.map(({ preparationDuration }) => preparationDuration));
  const maximumRestore = maximum(restores.map(({ preparationDuration }) => preparationDuration));
  await annotate(
    `10k clipboard mutation: cut max=${maximumCut.toFixed(3)} ms, ` +
      `restore max=${maximumRestore.toFixed(3)} ms, commit max=${maximumCommit.toFixed(3)} ms, ` +
      `slice max=${maximumSlice.toFixed(3)} ms`,
    "performance",
  );

  expect(cuts).toHaveLength(5);
  expect(restores).toHaveLength(5);
  expect(maximumCut).toBeLessThanOrEqual(750);
  expect(maximumRestore).toBeLessThanOrEqual(750);
  expect(maximumCommit).toBeLessThanOrEqual(8);
  expect(maximumSlice).toBeLessThanOrEqual(8);
  expect(store.size).toBe(11_000);
}, 60_000);

async function measureMutation(
  store: ElementStore,
  mutation: ElementMutation,
  expectedSizeBeforeCommit: number,
): Promise<MutationMeasurement> {
  let partialStoreObserved = false;
  const scheduler = new MeasuredSliceScheduler(4, () => {
    partialStoreObserved ||= store.size !== expectedSizeBeforeCommit;
  });
  const preparationStarted = performance.now();
  const prepared = await store.prepareElementMutation(mutation, scheduler);
  const preparationDuration = performance.now() - preparationStarted;
  if (prepared.status !== "prepared" || prepared.token === null) {
    throw new Error("Clipboard mutation benchmark could not prepare its atomic transaction.");
  }
  const commitStarted = performance.now();
  const committed = store.commitPreparedElementMutation(prepared.token);
  const commitDuration = performance.now() - commitStarted;
  scheduler.finish();
  if (committed.status !== "committed" || committed.transition === null) {
    throw new Error("Clipboard mutation benchmark could not commit its atomic transaction.");
  }
  expect(partialStoreObserved).toBe(false);
  return {
    commitDuration,
    maximumSlice: scheduler.maxSliceDuration,
    preparationDuration,
    transition: committed.transition,
  };
}

function maximum(values: readonly number[]): number {
  return Math.max(...values);
}

function remainingBand(
  store: ElementStore,
  band: "content" | "highlight",
  removed: ReadonlySet<string>,
): readonly string[] {
  return store.materializeBandOrder(band).filter((id) => !removed.has(id));
}
