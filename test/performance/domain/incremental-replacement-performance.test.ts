import { expect, it, vi } from "vitest";
import * as elementValidation from "../../../src/domain/schema/element-validation";
import { applySelectionStyleChange } from "../../../src/editor/tools/style-change";
import { ElementStore } from "../../../src/domain/store/public";
import { SelectionHandleSession } from "../../../src/editor/selection/handle-session";
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

it("reuses 10,000 owned sample buffers during style planning and commit", () => {
  const fixture = createStandardDomainFixture();
  const store = new ElementStore(fixture.elements);
  const strokes = fixture.strokeIds.map((id) => requireStroke(store, id));
  const validate = vi.spyOn(elementValidation, "validateRuntimeInkElementV1");
  try {
    const replacements = applySelectionStyleChange(strokes, { property: "opacity", value: 0.4 });
    const plan = store.planReplacements(replacements.elements)!;
    const delta = store.replaceMany(plan.replacements);
    expect(delta?.changes).toHaveLength(10_000);
    // Observe inputs at the actual schema boundary: original samples never reenter it.
    expect(validate.mock.calls.length).toBeLessThanOrEqual(30_000);
    expect(validate.mock.calls.length).toBeGreaterThan(0);
    for (const [element] of validate.mock.calls) {
      expect((element as { points: number[] }).points.length).toBe(3);
    }
    for (const stroke of strokes) {
      const record = store.get(stroke.id)!;
      expect(record.element.kind === "stroke" && record.element.points).toBe(stroke.points);
      expect(record.element.kind === "stroke" && record.element.style.opacity).toBe(0.4);
    }
  } finally {
    validate.mockRestore();
  }
}, 30_000);

it("validates resize samples once at the authoritative prepared transaction", async () => {
  const fixture = createStandardDomainFixture();
  const store = new ElementStore(fixture.elements);
  const selected = fixture.strokeIds.slice(0, 1_001).map((id) => requireStroke(store, id));
  const sampleValues = selected.reduce((sum, stroke) => sum + stroke.points.length, 0);
  const scheduler = new CheckpointSliceScheduler(40);
  const session = new SelectionHandleSession({
    action: { kind: "scale", position: "bottom-right", anchor: { x: 0, y: 0 }, rotation: 0 },
    elements: selected,
    planner: store,
    startPointer: { x: 100, y: 100 },
  });
  session.update({ x: 110, y: 110 });
  const validate = vi.spyOn(elementValidation, "validateInkElementV1");
  try {
    const materialized = await session.prepareCommitTimeSliced(scheduler);
    expect(validate).not.toHaveBeenCalled();
    if (materialized.status !== "ready") throw new Error("Expected resize materialization.");
    const prepared = await store.prepareElementReplacement(materialized.replacements, scheduler);
    if (prepared.token === null) throw new Error("Expected resize transaction.");
    expect(validate.mock.calls).toHaveLength(selected.length);
    expect(
      validate.mock.calls.reduce(
        (sum, [element]) => sum + (element as { points: number[] }).points.length,
        0,
      ),
    ).toBe(sampleValues);
    expect(store.commitPreparedElementReplacement(prepared.token).status).toBe("committed");
    expect(store.commitPreparedElementReplacement(prepared.token).status).toBe("cancelled");
  } finally {
    validate.mockRestore();
  }
}, 30_000);
