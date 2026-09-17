import type { StrokeElementV1 } from "../../../src/domain/schema/public";
import { LiveStrokeBuilder } from "../../../src/editor/tools/live-stroke";
import { createMaximumStroke } from "./standard-domain-fixture";
import { distribution, type Distribution } from "./action-distribution";

export interface MaximumStrokeRun {
  readonly append: Distribution;
  readonly handoff: Distribution;
  readonly maximumFinalizedChunkSamples: number;
  readonly maximumTailSamples: number;
}

export function measureMaximumStrokeRun(strokeCount: number): MaximumStrokeRun {
  const source = createMaximumStroke();
  const appendDurations: number[] = [];
  const handoffDurations: number[] = [];
  let maximumTailSamples = 0;
  let maximumFinalizedChunkSamples = 0;
  for (let strokeIndex = 0; strokeIndex < strokeCount; strokeIndex += 1) {
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: source.style,
    });
    appendMaximumStroke(builder, source, appendDurations);
    const handoffStarted = performance.now();
    const commit = builder.finish();
    handoffDurations.push(performance.now() - handoffStarted);
    maximumTailSamples = Math.max(maximumTailSamples, commit.instrumentation.maximumTailSamples);
    maximumFinalizedChunkSamples = Math.max(
      maximumFinalizedChunkSamples,
      commit.instrumentation.maximumFinalizedChunkSamples,
    );
    if (
      commit.points.length !== 4096 * 3 ||
      commit.geometry.length === 0 ||
      commit.geometry.some(({ d }) => d.length === 0)
    ) {
      throw new Error("Maximum-stroke benchmark produced an incomplete handoff.");
    }
  }
  return {
    append: distribution(appendDurations),
    handoff: distribution(handoffDurations),
    maximumFinalizedChunkSamples,
    maximumTailSamples,
  };
}

function appendMaximumStroke(
  builder: LiveStrokeBuilder,
  source: StrokeElementV1,
  durations: number[],
): void {
  for (let point = 0; point < source.points.length; point += 3) {
    const started = performance.now();
    builder.append({
      pressure: source.points[point + 2] as number,
      time: point / 3,
      x: source.points[point] as number,
      y: source.points[point + 1] as number,
    });
    durations.push(performance.now() - started);
  }
}
