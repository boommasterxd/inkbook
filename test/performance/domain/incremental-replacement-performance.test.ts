import { expect, it } from "vitest";
import { ElementStore } from "../../../src/domain/store/public";
import { moveSelectionTimeSliced } from "../../../src/editor/selection/transforms";
import { CheckpointSliceScheduler, requireStroke } from "./domain-scenarios";
import { createStandardDomainFixture } from "./standard-domain-fixture";

it("prepares replacements incrementally and preserves unrelated records", async () => {
  const fixture = createStandardDomainFixture();
  const store = new ElementStore(fixture.elements);
  const selected = new Set(fixture.strokeIds);
  const unrelated = fixture.elements
    .filter(({ id }) => !selected.has(id))
    .map(({ id }) => store.get(id)!);
  const strokes = fixture.strokeIds.map((id) => requireStroke(store, id));
  const scheduler = new CheckpointSliceScheduler(40);
  store.resetInstrumentation();
  const moved = await moveSelectionTimeSliced(strokes, { x: 0.001, y: 0.001 }, scheduler);
  if (moved === null) throw new Error("Expected a complete transformed selection.");
  const prepared = await store.prepareElementReplacement(moved, scheduler);
  if (prepared.token === null) throw new Error("Expected a prepared replacement token.");
  scheduler.finish();
  expect(store.instrumentation.publishedDeltas).toBe(0);
  for (const stroke of strokes) expect(store.get(stroke.id)?.element).toBe(stroke);
  const result = store.commitPreparedElementReplacement(prepared.token);
  expect(result.status).toBe("committed");
  expect(result.delta?.changes).toHaveLength(10_000);
  expect(scheduler.checkpointCounts.length).toBeGreaterThan(1);
  expect(scheduler.checkpointCounts.every((count) => count <= 40)).toBe(true);
  for (const record of unrelated) expect(store.get(record.element.id)).toBe(record);
  expect(store.instrumentation).toMatchObject({
    fullStoreScans: 0,
    publishedDeltas: 1,
    recordReplacements: 10_000,
    timeSlicedIndexVisits: 10_000,
  });
}, 30_000);
