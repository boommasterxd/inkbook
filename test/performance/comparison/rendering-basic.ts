import {
  measureInteractionFrames,
  measureInteractionSequence,
} from "../interaction-refresh-profile";
import { expect } from "vitest";
import { createDenseViewportFixture } from "../../integration/rendering/scene/dense-viewport-fixture";
import {
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  FakeScheduler,
  asElement,
} from "../../unit/rendering/scene/fakes";
import type { ComparisonScenario } from "./contracts";
import {
  RENDERING_MODULES,
  RENDERING_PAGE,
  renderingFixture,
  renderingScene,
  freshRenderingKernel,
} from "./rendering-fixture";

const interactionFile = "test/performance/rendering/scene/interaction-refresh-profile.test.ts";
const denseFile = "test/performance/rendering/scene/dense-viewport-reconciliation.test.ts";

export const RENDERING_BASIC_SCENARIOS: readonly ComparisonScenario[] = [
  ...(["camera", "selection"] as const).map((phase): ComparisonScenario => ({
    id: `rendering-small-${phase}`,
    statistics: [{ kind: "p99", population: "samples", minimumSamples: 100 }],
    modules: RENDERING_MODULES,
    covers: [
      {
        file: interactionFile,
        test: "keeps 10,000-element camera and bounded selection frames",
        ordinals: [phase === "camera" ? 1 : 2],
      },
    ],
    execution: "sequence",
    sequenceLength: 600,

    warmupOperations: 0,
    create(impl) {
      return freshRenderingKernel(() => {
        const { store, ids } = renderingFixture(impl);
        const { renderer, scheduler } = renderingScene(impl, store);
        scheduler.runAll();
        if (phase === "selection") {
          measureInteractionFrames((frame) => {
            renderer.setCamera({ x: -10 + Math.sin(frame / 30) * 10, zoom: 1 });
            scheduler.runAll();
          });
          renderer.setPreviewTransform(ids, "translate(0 0)", 1);
          scheduler.runAll();
        }
        let samples: number[] = [];
        return {
          *run() {
            samples = [];
            yield* measureInteractionSequence(
              (frame) => {
                if (phase === "camera")
                  renderer.setCamera({ x: -10 + Math.sin(frame / 30) * 10, zoom: 1 });
                else
                  renderer.setPreviewTransform(
                    ids,
                    `translate(${String(frame / 10)} 0)`,
                    frame + 2,
                  );
                scheduler.runAll();
              },
              600,
              samples,
            );
          },
          measurementSamples: () => samples,
          verify() {
            expect(renderer.mountedCount).toBeGreaterThan(0);
            expect(renderer.mountedCount).toBeLessThan(10_000);
            expect(scheduler.pendingCount).toBe(0);
          },
          dispose: () => renderer.destroy(),
        };
      });
    },
  })),
  ...(["desktop", "mobile"] as const).map((platform): ComparisonScenario => ({
    id: `rendering-dense-${platform}`,
    statistics: [{ kind: "max", population: "operations", minimumSamples: 1 }],
    modules: ["rendering/scene/index"],
    covers: [
      {
        file: denseFile,
        test: `meets the isolated ${platform} frame and elapsed deadlines`,
        ordinals: [1],
      },
    ],
    execution: "sync",

    warmupOperations: 1,
    create(impl) {
      const { SvgSceneRenderer } =
        impl.get<typeof import("../../../src/rendering/scene/index")>("rendering/scene/index");
      const fixture = createDenseViewportFixture();
      let renderer: InstanceType<typeof SvgSceneRenderer> | undefined;
      const scheduler = new FakeScheduler();
      return {
        reset() {
          renderer?.destroy();
        },
        run() {
          const store = new FakeSceneStore();
          for (const record of fixture.records) store.records.set(record.id, record);
          renderer = new SvgSceneRenderer({
            container: asElement(new FakeNode(new FakeDocument(), "div")),
            layout: {
              readViewport: () => ({
                height: platform === "desktop" ? 800 : 700,
                width: platform === "desktop" ? 1200 : 390,
                left: 0,
                top: 0,
              }),
            },
            page: RENDERING_PAGE,
            scheduler,
            store,
          });
          scheduler.runAll();
        },
        verify() {
          expect(renderer?.mountedIds("content")).toEqual(fixture.contentIds);
          expect(renderer?.mountedIds("highlight")).toEqual(fixture.highlightIds);
          expect(renderer?.instrumentation().geometryBuilds).toBe(2_500);
          expect(scheduler.pendingCount).toBe(0);
        },
        dispose() {
          renderer?.destroy();
        },
      };
    },
  })),
];
