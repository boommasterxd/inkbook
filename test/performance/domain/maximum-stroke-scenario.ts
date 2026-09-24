import { MAX_STROKE_POINTS } from "../../../src/domain/schema/public";
import type { StrokeElementV1 } from "../../../src/domain/schema/public";
import { LiveStrokeBuilder } from "../../../src/editor/tools/live-stroke";
import { createMaximumStroke } from "./standard-domain-fixture";

export interface MaximumStrokeRun {
  readonly appendedSamples: number;
  readonly completedStrokes: number;
  readonly maximumFinalizedChunkSamples: number;
  readonly maximumTailSamples: number;
}

export function runMaximumStrokes(strokeCount: number): MaximumStrokeRun {
  const source = createMaximumStroke();
  let appendedSamples = 0;
  let maximumTailSamples = 0;
  let maximumFinalizedChunkSamples = 0;
  for (let strokeIndex = 0; strokeIndex < strokeCount; strokeIndex += 1) {
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: source.style,
    });
    appendMaximumStroke(builder, source);
    const commit = builder.finish();
    appendedSamples += commit.instrumentation.appendedInputSamples;
    if (commit.instrumentation.commitBuilds !== 1) {
      throw new Error("Each stroke must build its commit exactly once.");
    }
    maximumTailSamples = Math.max(maximumTailSamples, commit.instrumentation.maximumTailSamples);
    maximumFinalizedChunkSamples = Math.max(
      maximumFinalizedChunkSamples,
      commit.instrumentation.maximumFinalizedChunkSamples,
    );
    if (
      commit.points.length !== MAX_STROKE_POINTS * 3 ||
      commit.geometry.length === 0 ||
      commit.geometry.some(({ d }) => d.length === 0)
    ) {
      throw new Error("Maximum-stroke benchmark produced an incomplete handoff.");
    }
  }
  return {
    appendedSamples,
    completedStrokes: strokeCount,
    maximumFinalizedChunkSamples,
    maximumTailSamples,
  };
}

function appendMaximumStroke(builder: LiveStrokeBuilder, source: StrokeElementV1): void {
  for (let point = 0; point < source.points.length; point += 3) {
    builder.append({
      pressure: source.points[point + 2] as number,
      time: point / 3,
      x: source.points[point] as number,
      y: source.points[point + 1] as number,
    });
  }
}
