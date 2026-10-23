import { observeSchemaArray } from "../../fixtures/domain/schema-array-work";
import { beforeAll, expect, it, vi } from "vitest";
import * as elementValidation from "../../../src/domain/schema/element-validation";
import * as sampleValidation from "../../../src/domain/schema/stroke-sample-range-validation";
import * as bottomHeap from "../../../src/domain/spatial/max-bottom-heap";
import { UniformSpatialIndex } from "../../../src/domain/spatial";
import { applySelectionStyleChange } from "../../../src/editor/tools/style-change";
import { ElementStore } from "../../../src/domain/store/public";
import type { ElementReplacementHistoryData } from "../../../src/domain/store/public";
import type { ImmutableInkElement } from "../../../src/domain/store/types";
import type { InkElementV1 } from "../../../src/domain/schema/public";
import * as recordFactory from "../../../src/domain/store/records/record-factory";
import * as bounds from "../../../src/domain/geometry/bounds";
import * as sampleCopy from "../../../src/domain/elements/runtime-sample-copy";
import * as connections from "../../../src/domain/store/records/connections";
import { DocumentCapacity } from "../../../src/domain/store/records/document-capacity";
import { ReplacementHistory } from "../../../src/domain/store/replacements/replacement-history";
import { DEFAULT_HISTORY_BYTE_LIMIT } from "../../../src/domain/commands/history";
import { SelectionHandleSession } from "../../../src/editor/selection/handle-session";
import {
  moveSelection,
  moveSelectionTimeSliced,
  rotateSelection,
} from "../../../src/editor/selection/transform/transforms";
import { scaleSelectionUniformForTest } from "../../fixtures/editor/selection-transform-reference";
import { CheckpointSliceScheduler, requireStroke } from "./domain-scenarios";
import { createStandardDomainFixture, type StandardDomainFixture } from "./standard-domain-fixture";

let fixtureBase: StandardDomainFixture;

beforeAll(() => {
  fixtureBase = createStandardDomainFixture();
  freezeFixtureValue(fixtureBase);
});

function freezeFixtureValue(value: object): void {
  for (const child of Object.values(value) as unknown[]) {
    if (child !== null && typeof child === "object") freezeFixtureValue(child);
  }
  Object.freeze(value);
}

it("bounds heap comparisons during 1,024 spatial replacement preparations", async () => {
  const index = new UniformSpatialIndex<number>();
  const original = { minX: 10, minY: 10, maxX: 20, maxY: 20 };
  const replacements = Array.from({ length: 1_024 }, (_, id) => ({
    bounds: { minX: 30, minY: id + 30, maxX: 40, maxY: id + 40 },
    id,
  }));
  index.insertMany(replacements.map(({ id }) => ({ bounds: original, id })));
  const sift = vi.spyOn(bottomHeap, "heapifyBottomAt");
  const comparisonsPerSlice: number[] = [];
  let observed = 0;
  try {
    const plan = await index.prepareReplacementsTimeSliced(replacements, {
      shouldYield: () => sift.mock.calls.length >= (comparisonsPerSlice.length + 1) * 256,
      yieldControl: async () => {
        const results = sift.mock.results.slice(observed);
        comparisonsPerSlice.push(
          results.reduce((sum, result) => sum + (result.value as number), 0),
        );
        observed = sift.mock.results.length;
        expect(index.getMaximumBottom()).toBe(20);
      },
    });
    expect(plan).not.toBe("cancelled");
    if (plan === "cancelled") return;
    expect(sift).toHaveBeenCalledTimes(512);
    expect(comparisonsPerSlice).toHaveLength(2);
    expect(comparisonsPerSlice.every((count) => count > 0 && count <= 5_120)).toBe(true);
    index.commitPreparedReplacements(plan);
    expect(index.getMaximumBottom()).toBe(1_063);
  } finally {
    sift.mockRestore();
  }
});

async function createObservedOwnedStore() {
  const observations: ReturnType<typeof observeSchemaArray>[] = [];
  const elements = fixtureBase.elements.map((element) => {
    if (element.kind !== "stroke") return { ...element };
    const observation = observeSchemaArray(element.points);
    observations.push(observation);
    // Fresh headers and observation identity keep each Store independent. Only
    // frozen numeric source values are shared; no Proxy substitutes a frozen property.
    return { ...element, points: observation.observed };
  });
  const fixture = { ...fixtureBase, elements };
  const builder = ElementStore.createBuilder({
    shouldYield: () => false,
    yieldControl: async () => undefined,
  });
  await builder.appendOwnedRuntime(fixture.elements);
  const store = await builder.finalize();
  if (store === null) throw new Error("Expected an owned fixture store.");
  for (const { work } of observations) {
    work.indexedReads = 0;
    work.descriptorReads = 0;
  }
  return { fixture, observations, store };
}

it("reuses synchronous candidate planning without preparing commit resources during previews", async () => {
  const { fixture, observations, store } = await createObservedOwnedStore();
  const target = store.get(fixture.connectedTargetId)!.element as InkElementV1;
  const validation = vi.spyOn(elementValidation, "validateInkElementV1");
  const graph = vi.spyOn(connections, "assertAcyclicConnections");
  const resolution = vi.spyOn(connections, "resolveConnections");
  const geometry = vi.spyOn(bounds, "calculateElementBoundsSteps");
  const capacity = vi.spyOn(DocumentCapacity.prototype, "prepare");
  const index = vi.spyOn(UniformSpatialIndex.prototype, "prepareReplacements");
  const history = vi.spyOn(ReplacementHistory.prototype, "createBuilder");
  const expectOnePlanningPass = () => {
    expect(validation).toHaveBeenCalledTimes(257);
    expect(graph).toHaveBeenCalledTimes(1);
    expect(resolution).toHaveBeenCalledTimes(512);
    expect(store.instrumentation.reverseDependencyVisits).toBe(512);
  };
  try {
    store.resetInstrumentation();
    const plan = store.planReplacements(moveSelection([target], { x: 0.001, y: 0.001 }))!;
    expect(plan.elements).toHaveLength(257);
    expectOnePlanningPass();
    expect(geometry).not.toHaveBeenCalled();
    expect(capacity).not.toHaveBeenCalled();
    expect(index).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    const capture = vi.fn<(history: ElementReplacementHistoryData) => void>();
    expect(store.replaceMany(plan.replacements, capture)?.changes).toHaveLength(257);
    expectOnePlanningPass();
    expect(geometry).toHaveBeenCalledTimes(257);
    expect(capacity).toHaveBeenCalledOnce();
    expect(index).toHaveBeenCalledOnce();
    expect(history).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0]![0].previous).toHaveLength(257);
    expect(
      observations.every(({ work }) => work.indexedReads === 0 && work.descriptorReads === 0),
    ).toBe(true);
  } finally {
    vi.restoreAllMocks();
  }
}, 20_000);

it("prepares replacements incrementally and preserves unrelated records", async () => {
  const { fixture, observations, store } = await createObservedOwnedStore();
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
  expect(
    observations.every(({ work }) => work.indexedReads === 0 && work.descriptorReads === 0),
  ).toBe(true);
  for (const stroke of strokes) {
    const moved = store.get(stroke.id)!.element;
    expect(moved.kind === "stroke" && moved.points).toBe(stroke.points);
  }
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

const retainedTransforms = {
  move: (elements: readonly InkElementV1[]) => moveSelection(elements, { x: 2, y: 3 }),
  rotate: (elements: readonly InkElementV1[]) => rotateSelection(elements, { x: 0, y: 0 }, 37),
  scale: (elements: readonly InkElementV1[]) =>
    scaleSelectionUniformForTest(elements, { x: 0, y: 0 }, 2),
};

it.each([
  ["sync", "move"],
  ["sync", "rotate"],
  ["sync", "scale"],
  ["sliced", "move"],
  ["sliced", "rotate"],
  ["sliced", "scale"],
] as const)(
  "reuses actual 10,000-stroke %s %s history without rebuilding samples or bounds",
  async (mode, transform) => {
    const { fixture, observations, store } = await createObservedOwnedStore();
    const original = fixture.strokeIds.map((id) => store.get(id)!);
    const initial = original.map(({ element }) => element as InkElementV1);
    const history = await apply(retainedTransforms[transform](initial));
    const changed = fixture.strokeIds.map((id) => store.get(id)!);
    expect(history.previous).toHaveLength(10_000);
    expect(history.replacements).toHaveLength(10_000);
    expect(history.payloadBytes).toBeLessThanOrEqual(DEFAULT_HISTORY_BYTE_LIMIT);
    for (const { work } of observations) {
      work.indexedReads = 0;
      work.descriptorReads = 0;
    }
    store.resetInstrumentation();
    const probes = [
      vi.spyOn(recordFactory, "createReplacementRecord"),
      vi.spyOn(recordFactory, "createOwnedReplacementRecordSteps"),
      vi.spyOn(recordFactory, "createOwnedTranslatedReplacementRecord"),
      vi.spyOn(bounds, "calculateElementBoundsSteps"),
      vi.spyOn(sampleCopy, "copySampleRange"),
      vi.spyOn(sampleCopy, "compareSampleRange"),
    ];
    try {
      await apply(history.previous);
      for (const record of original) {
        const restored = store.get(record.element.id)!;
        expect(restored.element).toBe(record.element);
        expect(restored.bounds).toBe(record.bounds);
        expect(restored.geometryVersion).toBeGreaterThan(record.geometryVersion);
      }
      await apply(history.replacements);
      for (const record of changed) {
        const redone = store.get(record.element.id)!;
        expect(redone.element).toBe(record.element);
        expect(redone.bounds).toBe(record.bounds);
        expect(redone.geometryVersion).toBeGreaterThan(record.geometryVersion);
      }
      for (const probe of probes) expect(probe).not.toHaveBeenCalled();
      expect(
        observations.every(({ work }) => work.indexedReads === 0 && work.descriptorReads === 0),
      ).toBe(true);
      expect(store.instrumentation).toMatchObject({
        bandScans: 0,
        fullStoreScans: 0,
        snapshotMaterializations: 0,
        recordReplacements: 20_000,
      });
    } finally {
      for (const probe of probes) probe.mockRestore();
    }

    async function apply(
      elements: readonly ImmutableInkElement[],
    ): Promise<ElementReplacementHistoryData> {
      const inputs = elements as readonly InkElementV1[];
      if (mode === "sync") {
        let captured: ElementReplacementHistoryData | undefined;
        expect(
          store.replaceMany(inputs, (data) => {
            captured = data;
          }),
        ).not.toBeNull();
        if (captured === undefined) throw new Error("Expected canonical replacement history.");
        return captured;
      }
      const prepared = await store.prepareElementReplacement(inputs, {
        shouldYield: () => false,
        yieldControl: async () => undefined,
      });
      if (prepared.token === null) throw new Error("Expected prepared replacement.");
      const committed = store.commitPreparedElementReplacement(prepared.token);
      if (committed.history === null) throw new Error("Expected canonical replacement history.");
      return committed.history;
    }
  },
  60_000,
);

it("validates 10,000 owned style replacements once without reading their samples", async () => {
  const { fixture, observations, store } = await createObservedOwnedStore();
  const strokes = fixture.strokeIds.map((id) => requireStroke(store, id));
  const validate = vi.spyOn(elementValidation, "validateRuntimeInkElementV1");
  try {
    const replacements = applySelectionStyleChange(strokes, { property: "opacity", value: 0.4 });
    const plan = store.planReplacements(replacements.elements)!;
    const delta = store.replaceMany(plan.replacements);
    expect(delta?.changes).toHaveLength(10_000);
    // Observe inputs at the actual schema boundary: original samples never reenter it.
    expect(validate.mock.calls).toHaveLength(10_000);
    for (const [element] of validate.mock.calls) {
      expect((element as { points: number[] }).points.length).toBe(3);
    }
    expect(
      observations.every(({ work }) => work.indexedReads === 0 && work.descriptorReads === 0),
    ).toBe(true);
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
  const fixture = fixtureBase;
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
  const validate = vi.spyOn(sampleValidation, "assertStrokeSampleRange");
  try {
    const materialized = await session.prepareCommitTimeSliced(scheduler);
    expect(validate).not.toHaveBeenCalled();
    if (materialized.status !== "ready") throw new Error("Expected resize materialization.");
    const prepared = await store.prepareElementReplacement(materialized.replacements, scheduler);
    if (prepared.token === null) throw new Error("Expected resize transaction.");
    expect(
      validate.mock.calls.reduce((sum, [, , , , range]) => sum + range.end - range.start, 0),
    ).toBe(sampleValues);
    expect(validate.mock.calls.every(([, , , , range]) => range.end - range.start <= 768)).toBe(
      true,
    );
    const stagedBuffers = new Set(validate.mock.calls.map(([points]) => points));
    expect(stagedBuffers.size).toBe(selected.length);
    for (const replacement of materialized.replacements) {
      if (replacement.kind === "stroke") expect(stagedBuffers.has(replacement.points)).toBe(false);
    }
    expect(store.commitPreparedElementReplacement(prepared.token).status).toBe("committed");
    expect(store.commitPreparedElementReplacement(prepared.token).status).toBe("cancelled");
  } finally {
    validate.mockRestore();
  }
}, 30_000);
