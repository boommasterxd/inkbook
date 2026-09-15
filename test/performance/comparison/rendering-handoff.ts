import { expect } from "vitest";
import type { InkElementV1 } from "../../../src/domain/schema/public";
import { sceneStoreDelta } from "../../fixtures/rendering/store-scene-delta";
import { MeasuredSliceScheduler } from "../domain/domain-scenarios";
import { collectProfileGarbage } from "../persistence/metrics";
import type { ComparisonImplementation, ComparisonKernel, ComparisonScenario } from "./contracts";
import {
  RENDERING_MODULES,
  RENDERING_PAGE,
  freshRenderingKernel,
  renderingMetricSamples,
  renderingFixture,
  renderingScene,
} from "./rendering-fixture";

export const RENDERING_HANDOFF_SCENARIOS: readonly ComparisonScenario[] = (
  ["subscriber", "commit"] as const
).map((phase): ComparisonScenario => ({
  id: `rendering-selection-handoff-${phase}`,
  statistics: [
    {
      kind: phase === "subscriber" ? "p99" : "max",
      population: "samples",
      minimumSamples: 100,
    },
  ],
  measurementGroup: "rendering-selection-handoff",
  modules: [...RENDERING_MODULES, "editor/selection/public"],
  covers: [
    {
      file: "test/performance/rendering/scene/selection-handoff-performance.test.ts",
      test: "keeps the real 10,000-element renderer subscriber",
      ordinals: [phase === "subscriber" ? 1 : 2],
    },
  ],
  execution: "async-sequence",
  sequenceLength: 101,

  warmupOperations: 0,
  create: (impl) => freshRenderingKernel(() => createHandoffKernel(impl, phase)),
}));

function createHandoffKernel(
  impl: ComparisonImplementation,
  phase: "subscriber" | "commit",
): ComparisonKernel {
  const { moveSelectionTimeSliced } =
    impl.get<typeof import("../../../src/editor/selection/public")>("editor/selection/public");
  const { store, ids } = renderingFixture(impl);
  const { renderer, scheduler } = renderingScene(impl, store);
  renderer.setPage(RENDERING_PAGE, 200_000);
  scheduler.runAll();
  let subscriber = 0;
  const unsubscribe = store.subscribe((delta) => {
    const start = performance.now();
    renderer.applyDelta(sceneStoreDelta(delta));
    subscriber = performance.now() - start;
  });
  const subscriberSamples: number[] = [];
  const commitSamples: number[] = [];
  const groups = {
    "rendering-selection-handoff-subscriber": subscriberSamples,
    "rendering-selection-handoff-commit": commitSamples,
  };
  let completed = 0;
  return {
    async *run() {
      subscriberSamples.length = 0;
      commitSamples.length = 0;
      for (let iteration = 0; iteration <= 100; iteration += 1) {
        const distance = iteration % 2 === 0 ? 0.001 : -0.001;
        const preparation = new MeasuredSliceScheduler(2);
        const replacements = await moveSelectionTimeSliced(
          ids.map((id) => store.get(id)?.element as InkElementV1),
          { x: distance, y: distance },
          preparation,
        );
        if (replacements === null) throw new Error("Handoff preparation cancelled.");
        const prepared = await store.prepareElementReplacement(replacements, preparation);
        if (prepared.status !== "prepared" || prepared.token === null)
          throw new Error("Handoff not prepared.");
        renderer.setPreviewTransform(
          ids,
          `translate(${String(distance)} ${String(distance)})`,
          iteration + 1,
        );
        scheduler.runAll();
        const handoff = renderer.beginPreviewCommit();
        renderer.clearPreviewTransforms();
        if (!handoff.arm(ids)) throw new Error("Handoff not armed.");
        renderer.resetInstrumentation();
        collectProfileGarbage();
        const started = performance.now();
        const result = store.commitPreparedElementReplacement(prepared.token);
        const elapsed = performance.now() - started;
        if (result.status !== "committed" || result.delta?.changes.length !== 10_000)
          throw new Error("Incomplete handoff.");
        if (iteration > 0) {
          subscriberSamples.push(subscriber);
          commitSamples.push(elapsed);
        }
        expect(renderer.instrumentation().motionGeometryTransitions).toBe(0);
        scheduler.runAll();
        completed += 1;
        yield;
      }
    },
    measurementSamples: (_result, metricId = `rendering-selection-handoff-${phase}`) =>
      renderingMetricSamples(groups, metricId),
    verify() {
      expect(completed).toBe(101);
      expect(subscriberSamples).toHaveLength(100);
      expect(commitSamples).toHaveLength(100);
      expect(renderer.hasPendingSceneCommit).toBe(false);
    },
    dispose() {
      unsubscribe();
      renderer.destroy();
    },
  };
}
