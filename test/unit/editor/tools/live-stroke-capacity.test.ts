import { describe, expect, it } from "vitest";
import { MAX_STROKE_POINTS } from "../../../../src/domain/schema/public";
import { LiveStrokeBuilder } from "../../../../src/editor/tools/live-stroke";

function createBuilder(pressureEnabled: boolean) {
  return new LiveStrokeBuilder({
    input: { pressureSource: "pen", zoom: 1 },
    style: {
      color: { type: "theme-text" },
      opacity: 0.5,
      pressureEnabled,
      smoothing: 0.5,
      width: 8,
    },
  });
}

function sample(index: number) {
  return { x: index, y: 10 * Math.sin(index / 8), pressure: 0.6, time: index };
}

function fill(builder: LiveStrokeBuilder, count: number) {
  return builder.appendBatch(Array.from({ length: count }, (_, index) => sample(index)));
}

describe("live stroke capacity", () => {
  it.each([false, true])(
    "preserves curves across the former limit with pressure=%s",
    (pressure) => {
      const builder = createBuilder(pressure);
      fill(builder, 4500);
      const commit = builder.finish();
      expect(builder.capacityExhausted).toBe(false);
      expect(commit.points).toHaveLength(4500 * 3);
      for (let index = 4090; index < 4500; index += 1) {
        expect(commit.points[index * 3]).toBe(index);
        expect(commit.points[index * 3 + 1]).toBeCloseTo(sample(index).y, 3);
      }
    },
  );

  it.each([false, true])("freezes overflow without rebuilding pressure=%s geometry", (pressure) => {
    const builder = createBuilder(pressure);
    const accepted = fill(builder, MAX_STROKE_POINTS);
    const before = builder.instrumentation();
    for (let index = 0; index < 128; index += 1) {
      const preview = builder.append(sample(MAX_STROKE_POINTS + index));
      expect(preview.tail).toBe(accepted.tail);
      expect(preview.finalizedChunks).toBe(accepted.finalizedChunks);
    }
    // Returning near the old endpoint must not restart an exhausted gesture.
    builder.append(sample(MAX_STROKE_POINTS - 1));
    expect(builder.capacityExhausted).toBe(true);
    expect(builder.instrumentation()).toEqual({
      ...before,
      appendedInputSamples: before.appendedInputSamples + 129,
    });
    const commit = builder.finish();
    expect(commit.points).toHaveLength(MAX_STROKE_POINTS * 3);
    expect(commit.points.slice(-3, -1)).toEqual([
      MAX_STROKE_POINTS - 1,
      Number(sample(MAX_STROKE_POINTS - 1).y.toFixed(3)),
    ]);
  });

  it("allows only bounded close-tip replacement before exhaustion and still validates input", () => {
    const builder = createBuilder(false);
    fill(builder, MAX_STROKE_POINTS);
    const last = sample(MAX_STROKE_POINTS - 1);
    builder.append({ ...last, x: last.x + 0.2 });
    expect(builder.capacityExhausted).toBe(false);
    builder.append({ ...last, x: last.x + 0.6 });
    expect(builder.capacityExhausted).toBe(true);
    expect(() => builder.append({ ...last, x: Number.NaN })).toThrow(RangeError);
    expect(() => builder.append({ ...last, pressure: Number.NaN })).toThrow(RangeError);
    const points = builder.finish().points;
    expect(points[points.length - 3]).toBe(last.x + 0.2);
  });
});
