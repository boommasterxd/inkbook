import { sceneStoreDelta } from "../../fixtures/rendering/store-scene-delta";
import { expect } from "vitest";
import type { InkElementV1 } from "../../../src/domain/schema/public";
import type { ComparisonScenario } from "./contracts";
import {
  RENDERING_MODULES,
  RENDERING_PAGE,
  RenderingProfileScheduler,
  renderingFixture,
  renderingScene,
  freshRenderingKernel,
  renderingMetricSamples,
} from "./rendering-fixture";

const file = "test/performance/rendering/scene/interaction-refresh-reconciliation.test.ts";
const cameraTest = "keeps coalesced pan, zoom, and viewport jumps within budget";
const commitTest = "keeps preview-to-single-element commit handoff within budget";

function measured(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

export const RENDERING_RECONCILIATION_SCENARIOS: readonly ComparisonScenario[] = [
  ...(["first", "follow-up"] as const).map((phase): ComparisonScenario => ({
    id: `rendering-reconcile-camera-${phase}`,
    statistics:
      phase === "follow-up"
        ? [{ kind: "p99", population: "samples", minimumSamples: 100, fallback: "max" }]
        : [{ kind: "p99", population: "samples", minimumSamples: 100 }],
    measurementGroup: "rendering-reconcile-camera",
    modules: RENDERING_MODULES,
    covers: [{ file, test: cameraTest, ordinals: [phase === "first" ? 1 : 2] }],
    execution: "sequence",
    sequenceLength: 600,

    warmupOperations: 0,
    create(impl, hz) {
      return freshRenderingKernel(() => {
        const { store } = renderingFixture(impl);
        const scheduler = new RenderingProfileScheduler(hz);
        const { renderer } = renderingScene(impl, store, scheduler, () => (1_000 / hz) * 0.55);
        renderer.setPage(RENDERING_PAGE, 2_000);
        scheduler.runAll();
        const firstSamples: number[] = [];
        const followUpSamples: number[] = [];
        const groups = {
          "rendering-reconcile-camera-first": firstSamples,
          "rendering-reconcile-camera-follow-up": followUpSamples,
        };
        return {
          *run() {
            firstSamples.length = 0;
            followUpSamples.length = 0;
            for (let frame = 0; frame < 600; frame += 1) {
              const step = frame % 4;
              renderer.setViewport({ height: 100, left: 0, top: step < 2 ? 0 : 800, width: 100 });
              renderer.setCamera({ x: step % 2 === 0 ? 0 : -50, zoom: step % 3 === 0 ? 1.05 : 1 });
              const first = measured(() => scheduler.runNext());
              firstSamples.push(first);
              while (scheduler.pendingCount > 0) {
                const duration = measured(() => scheduler.runNext());
                followUpSamples.push(duration);
              }
              yield;
            }
          },
          measurementSamples: (_result, metricId = `rendering-reconcile-camera-${phase}`) =>
            renderingMetricSamples(groups, metricId),
          verify() {
            expect(firstSamples).toHaveLength(600);
            expect(followUpSamples.length).toBeGreaterThan(0);
            expect(scheduler.pendingCount).toBe(0);
            expect(renderer.mountedCount).toBeGreaterThan(0);
            expect(renderer.mountedCount).toBeLessThan(10_000);
          },
          dispose: () => renderer.destroy(),
        };
      });
    },
  })),
  ...(["preview", "commit-frame", "operation", "follow-up"] as const).map(
    (phase, index): ComparisonScenario => ({
      id: `rendering-reconcile-commit-${phase}`,
      statistics:
        phase === "follow-up"
          ? [{ kind: "p99", population: "samples", minimumSamples: 100, fallback: "max" }]
          : [{ kind: "p99", population: "samples", minimumSamples: 100 }],
      measurementGroup: "rendering-reconcile-commit",
      modules: [...RENDERING_MODULES, "editor/selection/transforms"],
      covers: [{ file, test: commitTest, ordinals: [index + 1] }],
      execution: "sequence",
      sequenceLength: 600,

      warmupOperations: 0,
      create(impl, hz) {
        return freshRenderingKernel(() => {
          const { moveSelection } = impl.get<
            typeof import("../../../src/editor/selection/transforms")
          >("editor/selection/transforms");
          const { store, ids } = renderingFixture(impl);
          const scheduler = new RenderingProfileScheduler(hz);
          const { renderer } = renderingScene(impl, store, scheduler, () => (1_000 / hz) * 0.55);
          scheduler.runAll();
          const id = ids[0]!;
          const unsubscribe = store.subscribe((delta) =>
            renderer.applyDelta(sceneStoreDelta(delta)),
          );
          let epoch = 0;
          const previewSamples: number[] = [];
          const commitSamples: number[] = [];
          const operationSamples: number[] = [];
          const followUpSamples: number[] = [];
          const groups = {
            "rendering-reconcile-commit-preview": previewSamples,
            "rendering-reconcile-commit-commit-frame": commitSamples,
            "rendering-reconcile-commit-operation": operationSamples,
            "rendering-reconcile-commit-follow-up": followUpSamples,
          };
          const drain = () => {
            while (scheduler.pendingCount > 0) {
              const duration = measured(() => scheduler.runNext());
              followUpSamples.push(duration);
            }
          };
          return {
            *run() {
              for (const values of Object.values(groups)) values.length = 0;
              for (let frame = 0; frame < 600; frame += 1) {
                const step = frame % 4;
                const distance = step % 2 === 0 ? 0.01 : -0.01;
                renderer.setPreviewTransform([id], `translate(${String(distance)} 0)`, ++epoch);
                const preview = measured(() => scheduler.runNext());
                previewSamples.push(preview);
                drain();
                const operation = measured(() => {
                  const handoff = renderer.beginPreviewCommit();
                  renderer.clearPreviewTransforms();
                  if (!handoff.arm([id])) throw new Error("Unarmed preview handoff.");
                  const current = store.get(id)?.element as InkElementV1;
                  if (
                    store.replace(id, moveSelection([current], { x: distance, y: 0 })[0]!) === null
                  )
                    throw new Error("Preview replacement failed.");
                });
                operationSamples.push(operation);
                const commit = measured(() => scheduler.runNext());
                commitSamples.push(commit);
                drain();
                yield;
              }
            },
            measurementSamples: (_result, metricId = `rendering-reconcile-commit-${phase}`) =>
              renderingMetricSamples(groups, metricId),
            verify() {
              for (const values of [previewSamples, commitSamples, operationSamples])
                expect(values).toHaveLength(600);
              expect(followUpSamples.length).toBeGreaterThan(0);
              expect(renderer.hasPendingSceneCommit).toBe(false);
            },
            dispose() {
              unsubscribe();
              renderer.destroy();
            },
          };
        });
      },
    }),
  ),
];
