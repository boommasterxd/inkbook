import { describe, expect, it } from "vitest";

import type { StrokeStyleV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import type { GesturePreview } from "../../../../src/editor/gestures/public";
import { CoalescedPointerInput } from "../../../../src/obsidian/embeds/active-editor/coalesced-input";
import { CreationPreview } from "../../../../src/obsidian/embeds/active-editor/creation-preview";
import { activeEditorStoreHistory } from "../../../fixtures/obsidian/active-editor";
import { fakeNode, type FakeNode } from "../../../unit/rendering/scene/fakes";
import { LiveStrokeBuilder } from "../../../../src/editor/tools/live-stroke";
import {
  INTERACTION_REFRESH_PROFILE,
  interactionP99,
  interactionProfileAnnotation,
} from "../../interaction-refresh-profile";
import { timingBudget } from "../../timing-budget";
import {
  createInteractionFixture,
  createInteractionRenderer,
} from "./interaction-refresh-profile-fixture";

const LIVE_FRAME_COUNT = 450;
const SAMPLES_PER_FRAME = 8;
const PEN_STYLE: StrokeStyleV1 = {
  color: { type: "theme-text" },
  opacity: 1,
  pressureEnabled: true,
  smoothing: 0.5,
  width: 4,
};

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz live-stroke profile`, () => {
  it.for(["smooth", "dense zigzag"] as const)(
    "keeps %s live pressure-stroke updates within the main-thread p99 budget",
    async (shape, { annotate }) => {
      const { renderer, scheduler } = createInteractionRenderer(new ElementStore());
      scheduler.runAll();
      const style: StrokeStyleV1 = {
        ...PEN_STYLE,
        width: shape === "dense zigzag" ? 22 : PEN_STYLE.width,
      };
      const builder = new LiveStrokeBuilder({
        input: { pressureSource: "pen", zoom: 1 },
        style,
      });
      const durations: number[] = [];

      for (let frame = 0; frame < LIVE_FRAME_COUNT; frame += 1) {
        const startedAt = performance.now();
        const preview = builder.appendBatch(
          Array.from({ length: SAMPLES_PER_FRAME }, (_, sample) =>
            liveSample(frame * SAMPLES_PER_FRAME + sample, shape === "dense zigzag"),
          ),
        );
        renderer.updateLiveStroke(preview, style, "pen");
        durations.push(performance.now() - startedAt);
      }

      const p99 = interactionP99(durations);
      expect(p99).toBeLessThanOrEqual(timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms));
      expect(renderer.instrumentation()).toMatchObject({
        livePreviewUpdates: LIVE_FRAME_COUNT,
      });
      expect(renderer.instrumentation().liveMaximumTailNodes).toBe(1);
      await annotate(interactionProfileAnnotation(`${shape} live stroke`, p99), "performance");
      renderer.destroy();
    },
  );

  it.for(["pen", "mouse"] as const)(
    "keeps coalesced %s ink at the latest tip in the next frame with 10,000 stored strokes",
    async (pointerType, { annotate }) => {
      const { input, renderer, routed, scheduler, tail } = coalescedHarness(pointerType);
      const durations: number[] = [];
      for (let frame = 0; frame < LIVE_FRAME_COUNT; frame += 1) {
        const samples = Array.from({ length: SAMPLES_PER_FRAME }, (_, sample) =>
          pointerSample(frame * SAMPLES_PER_FRAME + sample, pointerType),
        );
        const startedAt = performance.now();
        input.dispatch(coalescedEvent(samples.slice(0, 4)));
        input.dispatch(coalescedEvent(samples.slice(4)));
        const pending = scheduler.pendingCount;
        scheduler.runNext();
        durations.push(performance.now() - startedAt);
        expect(pending).toBe(1);
        expect(scheduler.pendingCount).toBe(0);
        expectPressureTip(tail, samples[7]!);
      }
      const p99 = interactionP99(durations);
      expect(p99).toBeLessThanOrEqual(timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms));
      expect(renderer.instrumentation().livePreviewUpdates).toBe(LIVE_FRAME_COUNT + 1);
      await annotate(
        interactionProfileAnnotation(`coalesced ${pointerType} tip`, p99),
        "performance",
      );
      routed.revert();
      renderer.destroy();
    },
  );

  it("keeps long-stroke commit handoffs within the main-thread p99 budget", async ({
    annotate,
  }) => {
    const { renderer, scheduler } = createInteractionRenderer(new ElementStore());
    scheduler.runAll();
    const durations: number[] = [];
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: PEN_STYLE,
    });
    const preview = builder.appendBatch(
      Array.from({ length: 4096 }, (_, index) => liveSample(index)),
    );
    for (let index = 0; index < 120; index += 1) {
      renderer.updateLiveStroke(preview, PEN_STYLE, "pen");
      const startedAt = performance.now();
      renderer.commitLiveStroke(String(index));
      durations.push(performance.now() - startedAt);
      scheduler.runAll();
    }
    const p99 = interactionP99(durations);
    expect(p99).toBeLessThanOrEqual(timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms));
    expect(renderer.instrumentation().liveTailNodesRemoved).toBe(120);
    await annotate(interactionProfileAnnotation("live stroke commit handoff", p99), "performance");
    renderer.destroy();
  });
});

function liveSample(index: number, dense = false) {
  return {
    pressure: 0.35 + (index % 11) * 0.05,
    time: index * INTERACTION_REFRESH_PROFILE.frameDurationMs,
    x: index * 0.75,
    y: 50 + Math.sin(index / (dense ? 1 : 20)) * 25,
  };
}

function coalescedHarness(pointerType: "pen" | "mouse") {
  const { store } = createInteractionFixture();
  const { renderer, scheduler } = createInteractionRenderer(store);
  scheduler.runAll();
  const preview = new CreationPreview({
    defaults: createBuiltInSettings().toolDefaults,
    history: activeEditorStoreHistory(store),
    identity: { createdAt: 0, id: "00000000-0000-4000-8000-999999999999" },
    renderer,
    start: {
      additive: false,
      kind: "tool-gesture",
      pointer: { pointerId: 1, pointerType, pressure: 0.5, x: 0, y: 50 },
      tool: "draw",
    },
  });
  let routed: GesturePreview = preview;
  const input = new CoalescedPointerInput({
    dispatchMove: (pointer) => routed.update(pointer),
    frameScheduler: scheduler,
    now: () => scheduler.now(),
    project: (event) => ({
      pointerId: 1,
      pointerType,
      pressure: event.pressure,
      x: event.clientX,
      y: event.clientY,
    }),
  });
  routed = input.wrap(preview);
  const camera = fakeNode(renderer.svg).nodes[1]!;
  const liveGroup = camera.nodes.find(
    (node) =>
      node.attributes.get("class") === "inkbook-scene-foreground" &&
      node.nodes[0]?.nodes[0]?.attributes.get("class") === "inkbook-theme-fill",
  );
  const tail = liveGroup?.nodes[0];
  if (tail === undefined) throw new Error("Expected a retained live pressure tail.");
  return { input, renderer, routed, scheduler, tail };
}

function pointerSample(index: number, pointerType: "pen" | "mouse"): PointerEvent {
  const sample = liveSample(index);
  return {
    clientX: sample.x,
    clientY: sample.y,
    pointerId: 1,
    pointerType,
    pressure: sample.pressure,
    timeStamp: sample.time / SAMPLES_PER_FRAME,
  } as PointerEvent;
}

function coalescedEvent(samples: readonly PointerEvent[]): PointerEvent {
  return { ...samples[samples.length - 1]!, getCoalescedEvents: () => samples } as PointerEvent;
}

function expectPressureTip(tail: FakeNode, sample: PointerEvent): void {
  const d = tail.nodes[tail.nodes.length - 1]!.attributes.get("d")!;
  const runs = d.split("M");
  const run = `M${runs[runs.length - 1]!}`;
  let current = [0, 0];
  for (const match of run.matchAll(/([MQAqa])([^MQAqaZ]*)/g)) {
    const command = match[1]!;
    const values = match[2]!.match(/-?(?:\d*\.)?\d+/g)!.map(Number);
    const endpoint = values
      .slice(-2)
      .map((value, axis) => value + (command === command.toLowerCase() ? current[axis]! : 0));
    if (command.toUpperCase() === "A") {
      expect((current[0]! + endpoint[0]!) / 2).toBeCloseTo(sample.clientX, 2);
      expect((current[1]! + endpoint[1]!) / 2).toBeCloseTo(sample.clientY, 2);
      return;
    }
    current = endpoint;
  }
  throw new Error("Expected a round pressure end cap.");
}
