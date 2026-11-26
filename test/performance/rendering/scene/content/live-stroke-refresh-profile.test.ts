import { expect, it } from "vitest";

import { createBuiltInSettings } from "../../../../../src/domain/settings/defaults";
import type { GesturePreview } from "../../../../../src/editor/gestures/public";
import { CoalescedPointerInput } from "../../../../../src/obsidian/embeds/active-editor/input/coalesced-input";
import { CreationPreview } from "../../../../../src/obsidian/embeds/active-editor/previews/creation-preview";
import { activeEditorStoreHistory } from "../../../../fixtures/obsidian/active-editor";
import { fakeNode, type FakeNode, FakeScheduler } from "../../../../unit/rendering/scene/fakes";
import { INTERACTION_REFRESH_PROFILE } from "../../../interaction-refresh-profile";
import {
  createInteractionFixture,
  createInteractionRenderer,
  createLivePressureSample,
  LIVE_STROKE_FRAME_COUNT,
  LIVE_STROKE_SAMPLES_PER_FRAME,
} from "../interaction-refresh-profile-fixture";

type PreviewOptions = ConstructorParameters<typeof CreationPreview>[0];
type InputOptions = ConstructorParameters<typeof CoalescedPointerInput>[0];

function livePreviewOptions(
  defaults: PreviewOptions["defaults"],
  history: PreviewOptions["history"],
  renderer: PreviewOptions["renderer"],
): PreviewOptions {
  return {
    defaults,
    history,
    identity: { createdAt: 0, id: "00000000-0000-4000-8000-999999999999" },
    renderer,
    start: {
      additive: false,
      kind: "tool-gesture",
      pointer: { pointerId: 1, pointerType: "pen", pressure: 0.5, x: 0, y: 50 },
      tool: "draw",
    },
  };
}

function liveInputOptions(
  scheduler: NonNullable<InputOptions["frameScheduler"]> & { now(): number },
  dispatchMove: InputOptions["dispatchMove"],
): InputOptions {
  return {
    dispatchMove,
    frameScheduler: scheduler,
    now: () => scheduler.now(),
    project: (event) => ({
      pointerId: 1,
      pointerType: "pen",
      pressure: event.pressure,
      x: event.clientX,
      y: event.clientY,
    }),
  };
}

it(`publishes the latest coalesced pen tip once per frame at ${INTERACTION_REFRESH_PROFILE.refreshRate} Hz`, () => {
  const { input, renderer, routed, scheduler, tail } = coalescedHarness();
  try {
    for (let frame = 0; frame < LIVE_STROKE_FRAME_COUNT; frame += 1) {
      const samples = Array.from({ length: LIVE_STROKE_SAMPLES_PER_FRAME }, (_, sample) =>
        pointerSample(frame * LIVE_STROKE_SAMPLES_PER_FRAME + sample),
      );
      input.dispatch(coalescedEvent(samples.slice(0, 4)));
      input.dispatch(coalescedEvent(samples.slice(4)));
      const updates = renderer.instrumentation().livePreviewUpdates;
      expect(scheduler.pendingCount).toBe(1);
      scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
      scheduler.runNext();
      expect(renderer.instrumentation().livePreviewUpdates).toBe(updates + 1);
      expect(scheduler.pendingCount).toBe(0);
      expectPressureTip(tail, samples[LIVE_STROKE_SAMPLES_PER_FRAME - 1]!);
    }
    expect(renderer.instrumentation().livePreviewUpdates).toBe(LIVE_STROKE_FRAME_COUNT + 1);
  } finally {
    routed.revert();
    renderer.destroy();
  }
});

function coalescedHarness() {
  const { store } = createInteractionFixture();
  const { renderer, scheduler } = createInteractionRenderer(
    store,
    new FakeScheduler(INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs),
  );
  scheduler.runAll();
  const preview = new CreationPreview(
    livePreviewOptions(
      createBuiltInSettings().toolDefaults,
      activeEditorStoreHistory(store),
      renderer,
    ),
  );
  let routed: GesturePreview = preview;
  const input = new CoalescedPointerInput(
    liveInputOptions(scheduler.workScheduler, (pointer) => routed.update(pointer)),
  );
  routed = input.wrap(preview);
  const camera = fakeNode(renderer.svg).nodes[1]!;
  const liveGroup = camera.nodes.find(
    (node) =>
      node.attributes.get("class") === "inkbook-scene-foreground" &&
      node.nodes[0]?.nodes[0]?.tagName === "path" &&
      node.nodes[0]?.nodes[0]?.attributes.get("stroke") === "none",
  );
  const tail = liveGroup?.nodes[0];
  if (tail === undefined) throw new Error("Expected a retained live pressure tail.");
  return { input, renderer, routed, scheduler, tail };
}

function pointerSample(index: number): PointerEvent {
  const sample = createLivePressureSample(index, INTERACTION_REFRESH_PROFILE.frameDurationMs);
  return {
    clientX: sample.x,
    clientY: sample.y,
    pointerId: 1,
    pointerType: "pen",
    pressure: sample.pressure,
    timeStamp: sample.time / LIVE_STROKE_SAMPLES_PER_FRAME,
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
  let tipDistance = Infinity;
  for (const match of run.matchAll(/([MLQAlqa])([^MLQAlqaZ]*)/g)) {
    const command = match[1]!;
    const values = match[2]!.match(/-?(?:\d*\.)?\d+/g)!.map(Number);
    const endpoint =
      command === "l"
        ? values.reduce(
            (position, value, index) => {
              position[index % 2]! += value;
              return position;
            },
            [...current],
          )
        : values
            .slice(-2)
            .map((value, axis) => value + (command === command.toLowerCase() ? current[axis]! : 0));
    if (command.toUpperCase() === "A") {
      const center = circularArcCenter(current, endpoint, values);
      tipDistance = Math.min(
        tipDistance,
        Math.hypot(center[0]! - sample.clientX, center[1]! - sample.clientY),
      );
    }
    current = endpoint;
  }
  // Tapered-nib end caps need not be semicircles; their circle still follows the latest sample.
  expect(tipDistance).toBeLessThan(0.02);
}

function circularArcCenter(
  start: readonly number[],
  end: readonly number[],
  values: readonly number[],
): number[] {
  const dx = (start[0]! - end[0]!) / 2;
  const dy = (start[1]! - end[1]!) / 2;
  const squared = dx * dx + dy * dy;
  const sign = values[3] === values[4] ? -1 : 1;
  const scale = squared === 0 ? 0 : sign * Math.sqrt(Math.max(0, values[0]! ** 2 / squared - 1));
  return [(start[0]! + end[0]!) / 2 + scale * dy, (start[1]! + end[1]!) / 2 - scale * dx];
}
