import { expect } from "vitest";
import type { ComparisonImplementation, ComparisonKernel, ComparisonScenario } from "./contracts";
import {
  fallbackElements,
  longPressureElements,
  RESIZE_WORKLOADS,
} from "../../fixtures/obsidian/selection-resize-elements";
import {
  PAGE,
  createInteraction,
  createMovePreview,
  createPipeline,
  maximumBottom,
  pointerAt,
  resizeHandle,
} from "../../fixtures/obsidian/selection-resize-pipeline";
import { resizeApi, OBSIDIAN_RESIZE_MODULES } from "./obsidian-resize-fixture";

const file = "test/performance/obsidian/selection-resize-frame-pipeline.test.ts";
const FRAME_COUNT = 600;
type ElementsFactory = (typeof RESIZE_WORKLOADS)[number][1];

interface FrameResult {
  durations: number[];
  geometryUpdated: boolean;
  pendingBounded: boolean;
}

function* measureFrames(
  runFrame: (frame: number) => { geometryUpdated: boolean; pendingBounded: boolean },
): Generator<void, FrameResult, unknown> {
  const result: FrameResult = { durations: [], geometryUpdated: true, pendingBounded: true };
  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    const start = performance.now();
    const checks = runFrame(frame);
    result.durations.push(performance.now() - start);
    result.geometryUpdated &&= checks.geometryUpdated;
    result.pendingBounded &&= checks.pendingBounded;
    yield;
  }
  return result;
}

function resizeKernel(
  impl: ComparisonImplementation,
  refreshRate: number,
  config: { elements: ElementsFactory; group: string; phase: "first" | "frames" },
): ComparisonKernel {
  const api = resizeApi(impl);
  let fixture: ReturnType<typeof createPipeline> | undefined;
  let interaction: ReturnType<typeof createInteraction> | undefined;
  let start = { x: 0, y: 0 };
  let layoutUpdates = 0;
  let pageGrowths = 0;
  function dispose() {
    interaction?.dispose();
    fixture?.renderer.destroy();
    fixture?.sceneStore.release();
    interaction = undefined;
    fixture = undefined;
  }
  return {
    reset() {
      dispose();
      const elements = config.elements();
      let pageHeight = api.derivePageExtent(PAGE, maximumBottom(api, elements)).activeHeight;
      const current = createPipeline(api, elements, pageHeight);
      fixture = current;
      layoutUpdates = 0;
      pageGrowths = 0;
      interaction = createInteraction(api, current, elements, (bottom) => {
        layoutUpdates += 1;
        const nextHeight = api.derivePageExtent(PAGE, bottom).activeHeight;
        if (nextHeight <= pageHeight) return;
        pageHeight = nextHeight;
        pageGrowths += 1;
        current.renderer.setPage(PAGE, pageHeight);
      });
      start = resizeHandle(api, elements);
      interaction.pointerDown({ ...start, pointerId: 1, pointerType: "mouse", pressure: 0 });
      current.renderer.resetInstrumentation();
    },
    run() {
      const current = fixture!;
      const active = interaction!;
      return measureFrames((frame) => {
        const before = current.renderer.instrumentation().contentGeometryWrites;
        for (let sample = 0; sample < 4; sample += 1)
          active.pointerMove(pointerAt(start, frame, sample));
        const pendingBounded = current.scheduler.pendingCount <= 2;
        current.scheduler.time += 1_000 / refreshRate;
        current.scheduler.runFrame();
        return {
          pendingBounded,
          geometryUpdated: current.renderer.instrumentation().contentGeometryWrites > before,
        };
      });
    },
    verify(result) {
      const measured = result as FrameResult;
      expect(measured.geometryUpdated).toBe(true);
      expect(measured.pendingBounded).toBe(true);
      expect(measured.durations).toHaveLength(FRAME_COUNT);
      expect(layoutUpdates).toBe(FRAME_COUNT);
      expect(pageGrowths).toBeGreaterThan(0);
    },
    measurementSamples(result, metricId = `${config.group}-${config.phase}`) {
      const durations = (result as FrameResult).durations;
      if (metricId === `${config.group}-first`) return durations.slice(0, 1);
      if (metricId === `${config.group}-frames`) return durations;
      throw new Error(`Unknown resize measurement: ${metricId}`);
    },
    dispose,
  };
}

function moveKernel(
  impl: ComparisonImplementation,
  refreshRate: number,
  elementsFactory: ElementsFactory,
): ComparisonKernel {
  const api = resizeApi(impl);
  let fixture: ReturnType<typeof createPipeline> | undefined;
  let preview: InstanceType<typeof api.MovePreview> | undefined;
  let layoutUpdates = 0;
  function dispose() {
    preview?.revert();
    fixture?.renderer.destroy();
    fixture?.sceneStore.release();
    preview = undefined;
    fixture = undefined;
  }
  return {
    reset() {
      dispose();
      const elements = elementsFactory();
      const current = createPipeline(
        api,
        elements,
        api.derivePageExtent(PAGE, maximumBottom(api, elements)).activeHeight,
      );
      fixture = current;
      layoutUpdates = 0;
      preview = createMovePreview(api, current, elements, () => {
        layoutUpdates += 1;
      });
      current.renderer.resetInstrumentation();
    },
    run() {
      const current = fixture!;
      const active = preview!;
      return measureFrames((frame) => {
        for (let sample = 0; sample < 4; sample += 1) {
          const progress = frame * 4 + sample + 1;
          active.updateSamples([
            {
              pointerId: 2,
              pointerType: "pen",
              pressure: 0.5,
              x: 100 + progress * 0.05,
              y: 100 + progress * 0.1,
            },
          ]);
        }
        const pendingBounded = current.scheduler.pendingCount <= 2;
        current.scheduler.time += 1_000 / refreshRate;
        current.scheduler.runFrame();
        return { pendingBounded, geometryUpdated: true };
      });
    },
    verify(result) {
      expect((result as FrameResult).pendingBounded).toBe(true);
      expect((result as FrameResult).durations).toHaveLength(FRAME_COUNT);
      expect(layoutUpdates).toBe(FRAME_COUNT);
    },
    measurementSamples: (result) => (result as FrameResult).durations,
    dispose,
  };
}

export const OBSIDIAN_RESIZE_SCENARIOS: readonly ComparisonScenario[] = [
  ...RESIZE_WORKLOADS.flatMap(([name, elements], index) =>
    (["first", "frames"] as const).map((phase): ComparisonScenario => ({
      id: `obsidian-resize-${String(index)}-${phase}`,
      measurementGroup: `obsidian-resize-${String(index)}`,
      modules: OBSIDIAN_RESIZE_MODULES,
      covers: [
        {
          file,
          test: `keeps ${name} pointer-to-scene frames within budget`,
          ordinals: [phase === "first" ? 1 : 2],
        },
      ],
      statistics: [
        {
          kind: phase === "first" ? "max" : "p99",
          population: "samples",
          minimumSamples: phase === "first" ? 1 : FRAME_COUNT,
        },
      ],
      execution: "sequence",
      sequenceLength: FRAME_COUNT,

      warmupOperations: 0,
      create: (impl, refreshRate) =>
        resizeKernel(impl, refreshRate, {
          elements,
          group: `obsidian-resize-${String(index)}`,
          phase,
        }),
    })),
  ),
  ...([longPressureElements, fallbackElements] as const).map(
    (elements, index): ComparisonScenario => ({
      id: `obsidian-move-${String(index)}`,
      modules: OBSIDIAN_RESIZE_MODULES,
      covers: [
        {
          file,
          test: "keeps coalesced S Pen selection moves within budget",
          ordinals: [index + 1],
        },
      ],
      statistics: [{ kind: "p99", population: "samples", minimumSamples: FRAME_COUNT }],
      execution: "sequence",
      sequenceLength: FRAME_COUNT,

      warmupOperations: 0,
      create: (impl, refreshRate) => moveKernel(impl, refreshRate, elements),
    }),
  ),
];
