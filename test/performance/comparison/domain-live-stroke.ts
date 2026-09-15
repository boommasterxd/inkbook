import { assert } from "vitest";

import { createMaximumStroke } from "../domain/standard-domain-fixture";
import type { ComparisonScenario } from "./contracts";

export const DOMAIN_LIVE_STROKE_SCENARIOS: readonly ComparisonScenario[] = [
  "append",
  "handoff",
  "batch",
].map((phase) => ({
  id: `domain-live-stroke-${phase}`,
  statistics: [
    {
      kind: phase === "handoff" ? "max" : "p99",
      population: "samples",
      minimumSamples: phase === "handoff" ? 20 : phase === "batch" ? 512 : 20 * 4096,
    },
  ],
  modules: ["editor/tools/live-stroke"],
  covers: [
    {
      file: `test/performance/domain/${phase === "batch" ? "pressure-outline-performance" : "domain-performance"}.test.ts`,
      test:
        phase === "batch"
          ? "keeps 4096-point live writing bounded"
          : "updates and hands off twenty maximum pressure strokes",
      ordinals: [phase === "handoff" ? 2 : 1],
    },
  ],
  execution: "sequence",
  sequenceLength: phase === "batch" ? 512 : 20,

  warmupOperations: 0,
  create(implementation) {
    const { LiveStrokeBuilder } = implementation.get<
      typeof import("../../../src/editor/tools/live-stroke")
    >("editor/tools/live-stroke");
    const source = createMaximumStroke();
    const batch = phase === "batch";
    const style = batch ? { ...source.style, width: 22 as const } : source.style;
    const samples = Array.from({ length: 4_096 }, (_, index) =>
      batch
        ? { x: index % 2 ? 200 : 0, y: index, pressure: index % 2, time: index }
        : {
            x: source.points[index * 3]!,
            y: source.points[index * 3 + 1]!,
            pressure: source.points[index * 3 + 2]!,
            time: index,
          },
    );
    let builders: InstanceType<typeof LiveStrokeBuilder>[] = [];
    let commits: ReturnType<InstanceType<typeof LiveStrokeBuilder>["finish"]>[] = [];
    let durations: number[] = [];
    function* appendInputs(builder: InstanceType<typeof LiveStrokeBuilder>) {
      for (let index = 0; index < samples.length; index += batch ? 8 : 1) {
        const input = batch ? samples.slice(index, index + 8) : samples[index]!;
        const started = performance.now();
        if (Array.isArray(input)) builder.appendBatch(input);
        else builder.append(input);
        if (phase !== "handoff") durations.push(performance.now() - started);
        if (batch) yield;
      }
    }
    return {
      reset() {
        builders = Array.from(
          { length: batch ? 1 : 20 },
          () => new LiveStrokeBuilder({ input: { pressureSource: "pen", zoom: 1 }, style }),
        );
        commits = [];
        durations = [];
      },
      *run() {
        for (const builder of builders) {
          yield* appendInputs(builder);
          const started = performance.now();
          const commit = builder.finish();
          if (phase === "handoff") durations.push(performance.now() - started);
          commits.push(commit);
          if (!batch) yield;
        }
        return durations;
      },
      measurementSamples() {
        return durations;
      },
      verify() {
        assert.equal(commits.length, batch ? 1 : 20);
        for (const commit of commits) {
          assert.equal(commit.points.length, 4_096 * 3);
          assert.ok(commit.geometry.length > 0);
          assert.ok(commit.geometry.every(({ d }) => d.length > 0));
          assert.ok(commit.instrumentation.maximumTailSamples <= 16);
          assert.ok(commit.instrumentation.maximumFinalizedChunkSamples <= 16);
        }
        assert.equal(durations.length, phase === "handoff" ? 20 : batch ? 512 : 20 * 4_096);
      },
      dispose() {
        builders = [];
        commits = [];
        durations = [];
      },
    };
  },
}));
