import { expect, it } from "vitest";

import {
  ElementStore,
  type AppliedElementMutation,
  type ElementMutation,
} from "../../../src/domain/store/public";

import { CheckpointSliceScheduler } from "./domain-scenarios";
import { createStandardDomainFixture } from "./standard-domain-fixture";

it("atomically cuts and restores 10,000 strokes while yielding during preparation", async () => {
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
  let publications = 0;
  const unsubscribe = store.subscribe(() => {
    publications += 1;
  });
  const cutTransition = await applyMutation(store, cut, 11_000);
  expect(store.size).toBe(1_000);
  expect(publications).toBe(1);
  await applyMutation(store, cutTransition.reverse, 1_000);
  expect(store.size).toBe(11_000);
  expect(publications).toBe(2);
  for (const id of fixture.strokeIds) expect(store.get(id)).toBeDefined();
  unsubscribe();
}, 60_000);

async function applyMutation(
  store: ElementStore,
  mutation: ElementMutation,
  expectedSizeBeforeCommit: number,
): Promise<AppliedElementMutation> {
  let yielded = 0;
  const scheduler = new CheckpointSliceScheduler(40, () => {
    yielded += 1;
    expect(store.size).toBe(expectedSizeBeforeCommit);
  });
  const prepared = await store.prepareElementMutation(mutation, scheduler);
  if (prepared.status !== "prepared" || prepared.token === null) {
    throw new Error("Clipboard mutation could not prepare its atomic transaction.");
  }
  const committed = store.commitPreparedElementMutation(prepared.token);
  scheduler.finish();
  if (committed.status !== "committed" || committed.transition === null) {
    throw new Error("Clipboard mutation could not commit its atomic transaction.");
  }
  expect(yielded).toBeGreaterThan(0);
  expect(scheduler.checkpointCounts.every((count) => count <= 40)).toBe(true);
  return committed.transition;
}

function remainingBand(
  store: ElementStore,
  band: "content" | "highlight",
  removed: ReadonlySet<string>,
): readonly string[] {
  return store.materializeBandOrder(band).filter((id) => !removed.has(id));
}
