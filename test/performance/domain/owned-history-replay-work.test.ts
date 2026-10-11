import { expect, it, vi } from "vitest";
import { ElementStore } from "../../../src/domain/store/public";
import * as runtimeCopy from "../../../src/domain/elements/runtime-element-copy";
import * as sampleCopy from "../../../src/domain/elements/runtime-sample-copy";
import * as validation from "../../../src/domain/elements/runtime-replacement-validation";
import * as equality from "../../../src/domain/store/element-comparison";
import * as payload from "../../../src/domain/store/mutation-payload";
import { MutationPreparationScheduler } from "../../../src/domain/store/mutation-preparation-scheduler";
import { createStandardRuntimeDomainFixture } from "./standard-domain-fixture";
import { uninterruptedMutationScheduler as scheduler } from "../../fixtures/domain/element-mutation";

it("replays 10,000 privately retained strokes without public staging, point scans or payload recounts", async () => {
  const fixture = createStandardRuntimeDomainFixture();
  const elements = fixture.elements.slice(0, fixture.strokeCount);
  const builder = ElementStore.createBuilder(scheduler);
  await builder.appendOwnedRuntime(elements);
  const store = await builder.finalize();
  if (store === null) throw new Error("Expected hydrated store.");
  const originals = elements.map(({ id }) => store.get(id)!);
  const removed = await store.prepareElementMutation(
    { bands: { content: [], highlight: [] }, removeIds: fixture.strokeIds },
    scheduler,
  );
  if (removed.token === null) throw new Error("Expected removal token.");
  const transition = store.commitPreparedElementMutation(removed.token).transition;
  if (transition === null) throw new Error("Expected transition.");
  const spies = [
    vi.spyOn(runtimeCopy, "captureRuntimeElementHeader"),
    vi.spyOn(sampleCopy, "compareSampleRange"),
    vi.spyOn(sampleCopy, "copySampleRange"),
    vi.spyOn(validation, "validateRuntimeReplacementSteps"),
  ];
  const payloadBytes = vi.spyOn(payload, "elementMutationPayloadBytes");
  const compare = vi.spyOn(equality, "elementsEqualSteps");
  const preparationRuns = vi.spyOn(MutationPreparationScheduler.prototype, "run");
  const published = vi.fn();
  store.subscribe(published);
  let interrupted = false;
  let yielded = 0;
  const work = {
    shouldYield: () => !interrupted,
    yieldControl: async () => {
      expect(store.size).toBe(0);
      expect(published).not.toHaveBeenCalled();
      interrupted = true;
      yielded += 1;
    },
  };
  try {
    for (const direction of ["reverse", "forward", "reverse"] as const) {
      const prepared = await store.prepareHistoryReplay(transition[direction], work, transition);
      if (prepared.token === null) throw new Error("Expected replay token.");
      expect(store.commitPreparedElementMutation(prepared.token).status).toBe("committed");
    }
    for (const spy of spies) expect(spy.mock.calls.length).toBe(0);
    // Capacity accounting still observes each removed/restored record once.
    // Recounting the retained history directions would exceed this bound.
    expect(payloadBytes.mock.calls.length).toBeLessThanOrEqual(fixture.strokeCount * 3);
    expect(compare.mock.calls.length).toBeLessThanOrEqual(fixture.strokeCount * 2);
    expect(compare.mock.calls.every(([left, right]) => left === right)).toBe(true);
    expect(yielded).toBe(1);
    expect(
      preparationRuns.mock.results.filter(({ value }) => value instanceof Promise).length,
    ).toBe(1);
    expect(published).toHaveBeenCalledTimes(3);
    expect(store.size).toBe(fixture.strokeCount);
    for (const original of originals) {
      const restored = store.get(original.element.id)!;
      expect(restored.element).toBe(original.element);
      expect(restored.bounds).toBe(original.bounds);
    }
  } finally {
    for (const spy of spies) spy.mockRestore();
    compare.mockRestore();
    payloadBytes.mockRestore();
    preparationRuns.mockRestore();
  }
});
