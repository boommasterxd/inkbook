import { liveInputOptions, livePreviewOptions } from "../../fixtures/rendering/live-input";
import { expect } from "vitest";
import type { StrokeStyleV1 } from "../../../src/domain/schema/public";
import type { ComparisonImplementation, ComparisonKernel, ComparisonScenario } from "./contracts";
import {
  RENDERING_MODULES,
  renderingFixture,
  renderingScene,
  freshRenderingKernel,
} from "./rendering-fixture";

const file = "test/performance/rendering/scene/live-stroke-refresh-profile.test.ts";
const style: StrokeStyleV1 = {
  color: { type: "theme-text" },
  opacity: 1,
  pressureEnabled: true,
  smoothing: 0.5,
  width: 4,
};
function sample(index: number, hz: number, dense = false) {
  return {
    pressure: 0.35 + (index % 11) * 0.05,
    time: (index * 1_000) / hz,
    x: index * 0.75,
    y: 50 + Math.sin(index / (dense ? 1 : 20)) * 25,
  };
}

function liveKernel(
  impl: ComparisonImplementation,
  hz: number,
  mode: "smooth" | "dense zigzag" | "commit",
): ComparisonKernel {
  const { LiveStrokeBuilder } = impl.get<typeof import("../../../src/editor/tools/live-stroke")>(
    "editor/tools/live-stroke",
  );
  const { renderer, scheduler } = renderingScene(impl, renderingFixture(impl, 0).store);
  const currentStyle: StrokeStyleV1 = { ...style, width: mode === "dense zigzag" ? 22 : 4 };
  let builder = new LiveStrokeBuilder({
    input: { pressureSource: "pen", zoom: 1 },
    style: currentStyle,
  });
  let samples: number[] = [];
  let commitPreview: ReturnType<typeof builder.appendBatch> | undefined;
  scheduler.runAll();
  return {
    reset() {
      renderer.clearLiveStroke();
      builder = new LiveStrokeBuilder({
        input: { pressureSource: "pen", zoom: 1 },
        style: currentStyle,
      });
      renderer.resetInstrumentation();
      if (mode === "commit") {
        commitPreview = builder.appendBatch(
          Array.from({ length: 4096 }, (_, index) => sample(index, hz)),
        );
      }
    },
    *run() {
      samples = [];
      if (mode === "commit") {
        if (commitPreview === undefined) throw new Error("Commit preview missing.");
        for (let index = 0; index < 120; index += 1) {
          renderer.updateLiveStroke(commitPreview, currentStyle, "pen");
          const start = performance.now();
          renderer.commitLiveStroke(String(index));
          samples.push(performance.now() - start);
          scheduler.runAll();
          yield;
        }
        return;
      }
      for (let frame = 0; frame < 450; frame += 1) {
        const start = performance.now();
        const preview = builder.appendBatch(
          Array.from({ length: 8 }, (_, point) =>
            sample(frame * 8 + point, hz, mode === "dense zigzag"),
          ),
        );
        renderer.updateLiveStroke(preview, currentStyle, "pen");
        samples.push(performance.now() - start);
        yield;
      }
    },
    measurementSamples: () => samples,
    verify() {
      scheduler.runAll();
      const metrics = renderer.instrumentation();
      expect(metrics.livePreviewUpdates).toBe(mode === "commit" ? 120 : 450);
      if (mode === "commit") expect(metrics.liveTailNodesRemoved).toBe(120);
      else expect(metrics.liveMaximumTailNodes).toBe(1);
    },
    dispose: () => renderer.destroy(),
  };
}

export const RENDERING_LIVE_SCENARIOS: readonly ComparisonScenario[] = [
  ...(["smooth", "dense zigzag", "commit"] as const).map((mode): ComparisonScenario => ({
    id: `rendering-live-${mode.replaceAll(" ", "-")}`,
    statistics: [{ kind: "p99", population: "samples", minimumSamples: 100 }],
    sequenceLength: mode === "commit" ? 120 : 450,
    modules: [...RENDERING_MODULES, "editor/tools/live-stroke"],
    covers: [
      {
        file,
        test:
          mode === "commit"
            ? "keeps long-stroke commit handoffs"
            : `keeps ${mode} live pressure-stroke updates`,
        ordinals: [1],
      },
    ],
    execution: "sequence",

    warmupOperations: 0,
    create: (impl, hz) => freshRenderingKernel(() => liveKernel(impl, hz, mode)),
  })),
  ...(["pen", "mouse"] as const).map((pointerType): ComparisonScenario => ({
    id: `rendering-coalesced-${pointerType}`,
    statistics: [{ kind: "p99", population: "samples", minimumSamples: 100 }],
    sequenceLength: 450,
    modules: [
      ...RENDERING_MODULES,
      "obsidian/embeds/active-editor/coalesced-input",
      "obsidian/embeds/active-editor/creation-preview",
      "obsidian/embeds/active-editor/history",
      "domain/settings/defaults",
    ],
    covers: [{ file, test: `keeps coalesced ${pointerType} ink at the latest tip`, ordinals: [1] }],
    execution: "sequence",

    warmupOperations: 0,
    create: (impl, hz) => freshRenderingKernel(() => coalescedKernel(impl, hz, pointerType)),
  })),
];

function coalescedKernel(
  impl: ComparisonImplementation,
  hz: number,
  pointerType: "pen" | "mouse",
): ComparisonKernel {
  const { CreationPreview } = impl.get<
    typeof import("../../../src/obsidian/embeds/active-editor/creation-preview")
  >("obsidian/embeds/active-editor/creation-preview");
  const { CoalescedPointerInput } = impl.get<
    typeof import("../../../src/obsidian/embeds/active-editor/coalesced-input")
  >("obsidian/embeds/active-editor/coalesced-input");
  const { ActiveEditorHistory } = impl.get<
    typeof import("../../../src/obsidian/embeds/active-editor/history")
  >("obsidian/embeds/active-editor/history");
  const { createBuiltInSettings } = impl.get<
    typeof import("../../../src/domain/settings/defaults")
  >("domain/settings/defaults");
  const { store } = renderingFixture(impl);
  const { renderer, scheduler } = renderingScene(impl, store);
  scheduler.runAll();
  const history = new ActiveEditorHistory({
    commitBandOrder: (order) => void store.reorderBands(order),
    commitElements: (elements) => void store.create(elements),
    commitPage: () => undefined,
    removeElements: (ids) => void store.remove(ids),
    replaceElements: (elements) => void store.replaceMany(elements),
  });
  let preview: ReturnType<InstanceType<typeof CoalescedPointerInput>["wrap"]> | undefined;
  const input = new CoalescedPointerInput(
    liveInputOptions(scheduler, (pointer) => preview?.update(pointer), pointerType),
  );
  let samples: number[] = [];
  return {
    reset() {
      preview?.revert();
      scheduler.runAll();
      renderer.resetInstrumentation();
      preview = input.wrap(
        new CreationPreview(
          livePreviewOptions(createBuiltInSettings().toolDefaults, history, renderer, pointerType),
        ),
      );
      renderer.resetInstrumentation();
    },
    *run() {
      samples = [];
      for (let frame = 0; frame < 450; frame += 1) {
        const points = Array.from({ length: 8 }, (_, point) => {
          const value = sample(frame * 8 + point, hz);
          return {
            clientX: value.x,
            clientY: value.y,
            pointerId: 1,
            pointerType,
            pressure: value.pressure,
            timeStamp: value.time / 8,
          } as PointerEvent;
        });
        const start = performance.now();
        for (const events of [points.slice(0, 4), points.slice(4)])
          input.dispatch({ ...events[3], getCoalescedEvents: () => events } as PointerEvent);
        scheduler.runNext();
        samples.push(performance.now() - start);
        yield;
      }
    },
    measurementSamples: () => samples,
    verify() {
      expect(renderer.instrumentation().livePreviewUpdates).toBe(450);
      expect(scheduler.pendingCount).toBe(0);
    },
    dispose() {
      preview?.revert();
      renderer.destroy();
    },
  };
}
