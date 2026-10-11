import { afterEach, describe, expect, it, vi } from "vitest";

import * as sampleCopy from "../../../../src/domain/elements/runtime-sample-copy";
import * as strokePosition from "../../../../src/domain/geometry/stroke-position";
import { MAX_STROKE_POINTS, type StrokeElementV1 } from "../../../../src/domain/schema/public";
import * as sampleValidation from "../../../../src/domain/schema/stroke-sample-range-validation";
import { validateRuntimeInkElementV1 } from "../../../../src/domain/schema/element-validation";
import type {
  ElementMutation,
  PreparedElementMutationResult,
} from "../../../../src/domain/store/types";
import { hydrateRuntimeStroke } from "../../../fixtures/domain/runtime-stroke-store";
import { maximumLengthHighlighter, IDS, rectangle } from "./fixtures";

afterEach(() => vi.restoreAllMocks());

type MutationMode = "insertion" | "replacement" | "owned-undo";

async function stagingFixture(mode: MutationMode) {
  const source = maximumLengthHighlighter();
  const { store, points } = await hydrateRuntimeStroke(source);
  const original = store.get(source.id)!;
  const removal = mode === "owned-undo" ? store.removeWithHistory([source.id]) : null;
  const input = removal?.transition.reverse.elements?.[0] as StrokeElementV1 | undefined;
  const candidate = input ?? {
    ...source,
    id: mode === "insertion" ? IDS.other : source.id,
    points: new Float64Array(points) as unknown as StrokeElementV1["points"],
    style: { ...source.style, opacity: 0.75 },
  };
  if (mode === "replacement") candidate.points[0] = 110;
  const mutation: ElementMutation = removal?.transition.reverse ?? {
    bands: {
      content: [],
      highlight: mode === "insertion" ? [source.id, candidate.id] : [source.id],
    },
    elements: [candidate],
  };
  const before = store.get(candidate.id);
  const initialDeltas = store.instrumentation.publishedDeltas;
  return {
    store,
    points,
    original,
    candidate,
    mutation,
    before,
    initialDeltas,
    replay: removal?.transition,
  };
}

/** Charge real production reads; a checkpoint observes accumulated work, never generator count. */
function observedScheduler(onYield: () => void = () => undefined) {
  const work = { pending: 0, copied: 0, compared: 0, validated: 0, geometry: 0, yields: 0 };
  const charge = (kind: "copied" | "compared" | "validated" | "geometry", amount: number) => {
    work[kind] += amount;
    work.pending += amount;
    // A leaf may start with a partial budget left, but adds at most 256 samples.
    expect(work.pending).toBeLessThan(512);
  };
  const copy = sampleCopy.copySampleRange;
  vi.spyOn(sampleCopy, "copySampleRange").mockImplementation((...args) => {
    charge("copied", (args[3] - args[2]) / 3);
    return copy(...args);
  });
  const compare = sampleCopy.compareSampleRange;
  vi.spyOn(sampleCopy, "compareSampleRange").mockImplementation((...args) => {
    const difference = compare(...args);
    charge(
      "compared",
      ((difference?.index === undefined ? args[3] : difference.index + 1) - args[2]) / 3,
    );
    return difference;
  });
  const validate = sampleValidation.assertStrokeSampleRange;
  vi.spyOn(sampleValidation, "assertStrokeSampleRange").mockImplementation((...args) => {
    charge("validated", (args[4].end - args[4].start) / 3);
    return validate(...args);
  });
  const worldPoint = strokePosition.strokeWorldPoint;
  vi.spyOn(strokePosition, "strokeWorldPoint").mockImplementation((...args) => {
    charge("geometry", 1);
    return worldPoint(...args);
  });
  return {
    work,
    shouldYield: () => work.pending >= 256,
    yieldControl: async () => {
      expect(work.pending).toBeGreaterThanOrEqual(256);
      work.pending = 0;
      work.yields += 1;
      onYield();
    },
  };
}

function requireToken(prepared: PreparedElementMutationResult) {
  if (prepared.token === null) throw new Error("Expected prepared mutation.");
  return prepared.token;
}

describe("element mutation bounded private staging", () => {
  it.each(["insertion", "replacement", "owned-undo"] as const)(
    "interrupts actual maximum-stroke work before atomic %s publication",
    async (mode) => {
      const fixture = await stagingFixture(mode);
      const { store, candidate, before, initialDeltas } = fixture;
      const allocate = vi.spyOn(sampleCopy, "allocateSampleCopy");
      const scheduler = observedScheduler(() => {
        expect(store.get(candidate.id)).toBe(before);
        expect(store.instrumentation.publishedDeltas).toBe(initialDeltas);
      });
      const prepared = await store.prepareElementMutation(
        fixture.mutation,
        scheduler,
        fixture.replay,
      );
      expect(scheduler.work.yields).toBeGreaterThanOrEqual(MAX_STROKE_POINTS / 256);
      const result = store.commitPreparedElementMutation(requireToken(prepared));
      expect(result.status).toBe("committed");
      expect(store.instrumentation.publishedDeltas).toBe(initialDeltas + 1);
      const adopted = store.get(candidate.id)!;
      if (mode === "owned-undo") {
        expect(adopted.element).toBe(fixture.original.element);
        expect(adopted.bounds).toBe(fixture.original.bounds);
        expect(result.transition).toBe(fixture.replay);
        expect(allocate).not.toHaveBeenCalled();
        expect(scheduler.work).toMatchObject({
          copied: 0,
          compared: MAX_STROKE_POINTS,
          geometry: 0,
        });
      } else {
        expect(scheduler.work.copied).toBeGreaterThanOrEqual(MAX_STROKE_POINTS);
        expect(scheduler.work.validated).toBe(MAX_STROKE_POINTS);
        expect(scheduler.work.geometry).toBeGreaterThanOrEqual(MAX_STROKE_POINTS);
        expect(result.transition?.forward.elements?.[0]).toMatchObject({ id: candidate.id });
      }
    },
  );
});

describe("element mutation captured input integrity", () => {
  it.each(["insertion", "replacement"] as const)(
    "publishes captured valid %s headers and prefix despite later public mutation",
    async (mode) => {
      const fixture = await stagingFixture(mode);
      const { store, candidate } = fixture;
      const expectedX = candidate.points[0];
      const scheduler = observedScheduler(() => {
        if (scheduler.work.yields !== 1) return;
        candidate.style.width = NaN as StrokeElementV1["style"]["width"];
        candidate.points[0] = NaN;
      });
      const prepared = await store.prepareElementMutation(fixture.mutation, scheduler);
      const result = store.commitPreparedElementMutation(requireToken(prepared));
      const adopted = store.get(candidate.id)!.element;
      const history = result.transition?.forward.elements?.[0];
      expect(adopted.style).toMatchObject({ width: 8 });
      if (adopted.kind !== "stroke" || history?.kind !== "stroke")
        throw new Error("Expected strokes.");
      expect(adopted.points).toBeInstanceOf(Float64Array);
      expect(adopted.points[0]).toBe(expectedX);
      expect(history.points[0]).toBe(expectedX);
      expect(history.style.width).toBe(8);
      expect(history.points).not.toBe(candidate.points);
      vi.restoreAllMocks();
      expect(validateRuntimeInkElementV1(adopted).ok).toBe(true);
      expect(validateRuntimeInkElementV1(history).ok).toBe(true);
    },
  );

  it.each([
    ["insertion", NaN],
    ["replacement", NaN],
    ["owned-undo", NaN],
    ["insertion", -0],
    ["replacement", -0],
    ["owned-undo", -0],
    ["insertion", 1_000_001],
    ["replacement", 1_000_001],
    ["owned-undo", 1_000_001],
  ] as const)("rejects uncopied %s sample %s without publishing", async (mode, invalid) => {
    const fixture = await stagingFixture(mode);
    const { store, candidate, before, initialDeltas } = fixture;
    const scheduler = observedScheduler(() => {
      if (scheduler.work.yields === 1) candidate.points[candidate.points.length - 3] = invalid;
    });
    await expect(
      store.prepareElementMutation(fixture.mutation, scheduler, fixture.replay),
    ).rejects.toThrow(RangeError);
    expect(store.get(candidate.id)).toBe(before);
    expect(store.instrumentation.publishedDeltas).toBe(initialDeltas);
    expect(fixture.points[fixture.points.length - 3]).toBe(183);
  });

  it("copies and validates a changed public undo buffer while retaining the private original", async () => {
    const fixture = await stagingFixture("owned-undo");
    fixture.candidate.points[0] = 110;
    const allocate = vi.spyOn(sampleCopy, "allocateSampleCopy");
    const scheduler = observedScheduler();
    const prepared = await fixture.store.prepareElementMutation(
      fixture.mutation,
      scheduler,
      fixture.replay,
    );
    expect(fixture.store.commitPreparedElementMutation(requireToken(prepared)).status).toBe(
      "committed",
    );
    expect(allocate).toHaveBeenCalledOnce();
    expect(scheduler.work.validated).toBe(MAX_STROKE_POINTS);
    expect(scheduler.work.copied).toBeGreaterThan(MAX_STROKE_POINTS - 1);
    expect(fixture.points[0]).toBe(100);
    const restored = fixture.store.get(fixture.candidate.id)!.element;
    if (restored.kind !== "stroke") throw new Error("Expected stroke.");
    expect(restored).not.toBe(fixture.original.element);
    expect(restored.points).not.toBe(fixture.points);
    expect(restored.points[0]).toBe(110);
  });
});

describe("element mutation staging cancellation", () => {
  it.each(["insertion", "replacement", "owned-undo"] as const)(
    "cancels %s inside the first actual sample leaf",
    async (mode) => {
      const fixture = await stagingFixture(mode);
      let cancelled = false;
      const scheduler = observedScheduler(() => {
        cancelled = true;
      });
      const prepared = await fixture.store.prepareElementMutation(
        fixture.mutation,
        { ...scheduler, isCancelled: () => cancelled },
        fixture.replay,
      );
      expect(prepared).toEqual({ status: "cancelled", token: null });
      expect(scheduler.work.yields).toBe(1);
      expect(fixture.store.get(fixture.candidate.id)).toBe(fixture.before);
      expect(fixture.store.instrumentation.publishedDeltas).toBe(fixture.initialDeltas);
    },
  );

  it("rejects preparation made stale by an interleaved store mutation", async () => {
    const fixture = await stagingFixture("replacement");
    const scheduler = observedScheduler(() => {
      if (scheduler.work.yields === 1) fixture.store.create([rectangle()]);
    });
    expect(await fixture.store.prepareElementMutation(fixture.mutation, scheduler)).toEqual({
      status: "cancelled",
      token: null,
    });
    expect(fixture.store.get(fixture.candidate.id)).toBe(fixture.before);
    expect(fixture.store.get(IDS.target)?.element.kind).toBe("rectangle");
    expect(fixture.store.instrumentation.publishedDeltas).toBe(fixture.initialDeltas + 1);
    expect(scheduler.work.yields).toBe(1);
  });
});
