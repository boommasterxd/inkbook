import { afterEach, describe, expect, it, vi } from "vitest";

import * as sampleCopy from "../../../../src/domain/elements/runtime-sample-copy";
import * as strokePosition from "../../../../src/domain/geometry/stroke-position";
import { MAX_STROKE_POINTS, type StrokeElementV1 } from "../../../../src/domain/schema/public";
import { hydrateRuntimeStroke } from "../../../fixtures/domain/runtime-stroke-store";
import { maximumLengthHighlighter } from "./fixtures";

afterEach(() => vi.restoreAllMocks());

async function longStrokeReplacement() {
  const source = maximumLengthHighlighter();
  const { store, points } = await hydrateRuntimeStroke(source);
  const replacement = {
    ...source,
    points: new Float64Array(points),
    style: { ...source.style, opacity: 0.75 },
  } as unknown as StrokeElementV1;
  return { store, replacement, before: store.get(source.id)! };
}

function sampleHandoff(onYield: () => void) {
  let pending = false;
  let yielded = false;
  const compare = sampleCopy.compareSampleRange;
  vi.spyOn(sampleCopy, "compareSampleRange").mockImplementation((...args) => {
    const result = compare(...args);
    if (!yielded) pending = true;
    return result;
  });
  return {
    shouldYield: () => pending,
    yieldControl: async () => {
      pending = false;
      yielded = true;
      onYield();
    },
  };
}

describe("replacement private staging", () => {
  it("adopts captured headers and samples when the public prefix changes during a handoff", async () => {
    const { store, replacement, before } = await longStrokeReplacement();
    const prepared = await store.prepareElementReplacement(
      [replacement],
      sampleHandoff(() => {
        replacement.style.width = NaN as StrokeElementV1["style"]["width"];
        replacement.points[0] = NaN;
      }),
    );
    expect(prepared.token).not.toBeNull();
    if (prepared.token === null) throw new Error("Expected replacement token.");
    expect(store.get(replacement.id)).toBe(before);
    expect(store.commitPreparedElementReplacement(prepared.token).status).toBe("committed");
    const adopted = store.get(replacement.id)!.element;
    expect(adopted.style).toMatchObject({ width: 8, opacity: 0.75 });
    if (adopted.kind !== "stroke" || before.element.kind !== "stroke")
      throw new Error("Expected stroke.");
    expect(adopted.points).toBe(before.element.points);
    expect(adopted.points[0]).toBe(100);
  });

  it.each([NaN, -0, 1_000_001])(
    "rejects invalid uncaptured sample %s after a handoff",
    async (invalid) => {
      const { store, replacement, before } = await longStrokeReplacement();
      await expect(
        store.prepareElementReplacement(
          [replacement],
          sampleHandoff(() => {
            replacement.points[replacement.points.length - 3] = invalid;
          }),
        ),
      ).rejects.toThrow(RangeError);
      expect(store.get(replacement.id)).toBe(before);
      expect(store.instrumentation.publishedDeltas).toBe(0);
    },
  );

  it("cancels inside a long sample comparison before publishing any change", async () => {
    const { store, replacement, before } = await longStrokeReplacement();
    let cancelled = false;
    const scheduler = sampleHandoff(() => {
      cancelled = true;
    });
    const prepared = await store.prepareElementReplacement([replacement], {
      ...scheduler,
      isCancelled: () => cancelled,
    });
    expect(prepared).toEqual({ status: "cancelled", token: null });
    expect(store.get(replacement.id)).toBe(before);
    expect(sampleCopy.compareSampleRange).toHaveBeenCalledOnce();
  });

  it("interrupts geometry creation within one maximum-length stroke", async () => {
    const { store, replacement, before } = await longStrokeReplacement();
    replacement.style = { ...replacement.style, width: 14 };
    let pointsSinceYield = 0;
    let yields = 0;
    const worldPoint = strokePosition.strokeWorldPoint;
    vi.spyOn(strokePosition, "strokeWorldPoint").mockImplementation((...args) => {
      pointsSinceYield += 1;
      expect(pointsSinceYield).toBeLessThanOrEqual(256);
      return worldPoint(...args);
    });
    const prepared = await store.prepareElementReplacement([replacement], {
      shouldYield: () => pointsSinceYield === 256,
      yieldControl: async () => {
        yields += 1;
        pointsSinceYield = 0;
        expect(store.get(replacement.id)).toBe(before);
      },
    });
    expect(yields).toBe(MAX_STROKE_POINTS / 256);
    expect(strokePosition.strokeWorldPoint).toHaveBeenCalledTimes(MAX_STROKE_POINTS);
    if (prepared.token === null) throw new Error("Expected replacement token.");
    expect(store.commitPreparedElementReplacement(prepared.token).status).toBe("committed");
  });
});
