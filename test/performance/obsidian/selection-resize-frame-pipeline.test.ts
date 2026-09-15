import { describe, expect, it } from "vitest";

import { calculateElementBounds, derivePageExtent } from "../../../src/domain/geometry/public";
import type { InkElementV1 } from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import { layoutSelectionHandles } from "../../../src/editor/selection/public";
import { ActiveEditorHandleInteraction } from "../../../src/obsidian/embeds/active-editor/handle-interaction";
import { ActiveEditorHistory } from "../../../src/obsidian/embeds/active-editor/history";
import { MovePreview } from "../../../src/obsidian/embeds/active-editor/move-preview";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import { SvgSceneRenderer } from "../../../src/rendering/scene";
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
  type ResizeApi,
} from "../../fixtures/obsidian/selection-resize-pipeline";
import {
  INTERACTION_REFRESH_PROFILE,
  interactionP99,
  interactionProfileAnnotation,
  measureInteractionFrames,
} from "../interaction-refresh-profile";
import { expectTiming } from "../timing-assertions";

const API: ResizeApi = {
  calculateElementBounds,
  derivePageExtent,
  layoutSelectionHandles,
  ElementStore,
  ActiveEditorHandleInteraction,
  ActiveEditorHistory,
  MovePreview,
  ElementSceneStore,
  SvgSceneRenderer,
};
const RAW_SAMPLES_PER_FRAME = 4;

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz selection resize frame pipeline`, () => {
  // Each independent workload retains its own default test deadline and frame budget.
  it.for(RESIZE_WORKLOADS)(
    "keeps %s pointer-to-scene frames within budget",
    async ([name, createElements], { annotate }) => {
      const result = measurePipeline(createElements());
      expect(result.layoutUpdates).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
      expect(result.pageGrowths).toBeGreaterThan(0);
      expectTiming(result.firstFrameMs, INTERACTION_REFRESH_PROFILE.atomicCommitMaxMs);
      expectTiming(result.p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms, { label: name });
      await annotate(interactionProfileAnnotation(name, result.p99), "performance");
      await annotate(
        `${name}: first preview frame=${result.firstFrameMs.toFixed(3)} ms`,
        "performance",
      );
    },
  );

  it("keeps coalesced S Pen selection moves within budget", async ({ annotate }) => {
    const profiles = [
      ["mixed connected S Pen move", longPressureElements()],
      ["10,000-stroke S Pen move", fallbackElements()],
    ] as const;
    for (const [name, elements] of profiles) {
      const result = measureMovePipeline(elements);
      expect(result.layoutUpdates).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
      expectTiming(result.p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
      await annotate(interactionProfileAnnotation(name, result.p99), "performance");
    }
  });
});

function measureMovePipeline(elements: readonly InkElementV1[]) {
  const fixture = createPipeline(
    API,
    elements,
    derivePageExtent(PAGE, maximumBottom(API, elements)).activeHeight,
  );
  let layoutUpdates = 0;
  const preview = createMovePreview(API, fixture, elements, () => {
    layoutUpdates += 1;
  });
  fixture.renderer.resetInstrumentation();
  const durations = measureInteractionFrames((frame) => {
    for (let sample = 0; sample < RAW_SAMPLES_PER_FRAME; sample += 1) {
      const progress = frame * RAW_SAMPLES_PER_FRAME + sample + 1;
      preview.updateSamples([
        {
          pointerId: 2,
          pointerType: "pen",
          pressure: 0.5,
          x: 100 + progress * 0.05,
          y: 100 + progress * 0.1,
        },
      ]);
    }
    expect(fixture.scheduler.pendingCount).toBeLessThanOrEqual(2);
    fixture.scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
    fixture.scheduler.runFrame();
  });
  preview.revert();
  fixture.renderer.destroy();
  fixture.sceneStore.release();
  return { layoutUpdates, p99: interactionP99(durations) };
}

function measurePipeline(elements: readonly InkElementV1[]) {
  let pageHeight = derivePageExtent(PAGE, maximumBottom(API, elements)).activeHeight;
  const fixture = createPipeline(API, elements, pageHeight);
  let layoutUpdates = 0;
  let pageGrowths = 0;
  const interaction = createInteraction(API, fixture, elements, (maximumBottom) => {
    layoutUpdates += 1;
    const nextHeight = derivePageExtent(PAGE, maximumBottom).activeHeight;
    if (nextHeight <= pageHeight) return;
    pageHeight = nextHeight;
    pageGrowths += 1;
    fixture.renderer.setPage(PAGE, pageHeight);
  });
  const start = resizeHandle(API, elements);
  interaction.pointerDown({ ...start, pointerId: 1, pointerType: "mouse", pressure: 0 });
  fixture.renderer.resetInstrumentation();
  const durations = measureInteractionFrames((frame) => {
    const before = fixture.renderer.instrumentation().contentGeometryWrites;
    for (let sample = 0; sample < RAW_SAMPLES_PER_FRAME; sample += 1) {
      interaction.pointerMove(pointerAt(start, frame, sample));
    }
    expect(fixture.scheduler.pendingCount).toBeLessThanOrEqual(2);
    fixture.scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
    fixture.scheduler.runFrame();
    expect(fixture.renderer.instrumentation().contentGeometryWrites).toBeGreaterThan(before);
  });
  interaction.dispose();
  fixture.renderer.destroy();
  fixture.sceneStore.release();
  return {
    firstFrameMs: durations[0]!,
    layoutUpdates,
    p99: interactionP99(durations),
    pageGrowths,
  };
}
