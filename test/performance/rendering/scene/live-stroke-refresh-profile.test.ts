import { describe, expect, it, vi } from "vitest";

import type { StrokeStyleV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import type { GesturePreview } from "../../../../src/editor/gestures/public";
import { CoalescedPointerInput } from "../../../../src/obsidian/embeds/active-editor/coalesced-input";
import { CreationPreview } from "../../../../src/obsidian/embeds/active-editor/creation-preview";
import { activeEditorStoreHistory } from "../../../fixtures/obsidian/active-editor";
import { fakeNode, FakeNode } from "../../../unit/rendering/scene/fakes";
import {
  LiveStrokeBuilder,
  type LiveStrokePreview,
} from "../../../../src/editor/tools/live-stroke";
import { INTERACTION_REFRESH_PROFILE } from "../../interaction-refresh-profile";
import {
  createInteractionFixture,
  createInteractionRenderer,
} from "./interaction-refresh-profile-fixture";

type PreviewOptions = ConstructorParameters<typeof CreationPreview>[0];
type InputOptions = ConstructorParameters<typeof CoalescedPointerInput>[0];

function livePreviewOptions(
  defaults: PreviewOptions["defaults"],
  history: PreviewOptions["history"],
  renderer: PreviewOptions["renderer"],
  pointerType: "pen" | "mouse",
): PreviewOptions {
  return {
    defaults,
    history,
    identity: { createdAt: 0, id: "00000000-0000-4000-8000-999999999999" },
    renderer,
    start: {
      additive: false,
      kind: "tool-gesture",
      pointer: { pointerId: 1, pointerType, pressure: 0.5, x: 0, y: 50 },
      tool: "draw",
    },
  };
}

function liveInputOptions(
  scheduler: NonNullable<InputOptions["frameScheduler"]> & { now(): number },
  dispatchMove: InputOptions["dispatchMove"],
  pointerType: "pen" | "mouse",
): InputOptions {
  return {
    dispatchMove,
    frameScheduler: scheduler,
    now: () => scheduler.now(),
    project: (event) => ({
      pointerId: 1,
      pointerType,
      pressure: event.pressure,
      x: event.clientX,
      y: event.clientY,
    }),
  };
}

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
    "bounds %s live pressure-stroke work across a growing stroke",
    (shape) => {
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

      for (let frame = 0; frame < LIVE_FRAME_COUNT; frame += 1) {
        const preview = builder.appendBatch(
          Array.from({ length: SAMPLES_PER_FRAME }, (_, sample) =>
            liveSample(frame * SAMPLES_PER_FRAME + sample, shape === "dense zigzag"),
          ),
        );
        renderer.updateLiveStroke(preview, style, "pen");
      }

      expect(renderer.instrumentation()).toMatchObject({
        livePreviewUpdates: LIVE_FRAME_COUNT,
        geometryBuilds: 0,
        contentGeometryWrites: 0,
        liveTailNodesCreated: 1,
      });
      expect(renderer.instrumentation().liveMaximumTailNodes).toBe(1);
      renderer.destroy();
    },
  );

  it.for(["pen", "mouse"] as const)(
    "keeps coalesced %s ink at the latest tip in the next frame with 10,000 stored strokes",
    (pointerType) => {
      const { input, renderer, routed, scheduler, tail } = coalescedHarness(pointerType);
      for (let frame = 0; frame < LIVE_FRAME_COUNT; frame += 1) {
        const samples = Array.from({ length: SAMPLES_PER_FRAME }, (_, sample) =>
          pointerSample(frame * SAMPLES_PER_FRAME + sample, pointerType),
        );
        input.dispatch(coalescedEvent(samples.slice(0, 4)));
        input.dispatch(coalescedEvent(samples.slice(4)));
        const updates = renderer.instrumentation().livePreviewUpdates;
        const pending = scheduler.pendingCount;
        scheduler.runNext();
        expect(renderer.instrumentation().livePreviewUpdates).toBe(updates + 1);
        expect(pending).toBe(1);
        expect(scheduler.pendingCount).toBe(0);
        expectPressureTip(tail, samples[7]!);
      }
      expect(renderer.instrumentation().livePreviewUpdates).toBe(LIVE_FRAME_COUNT + 1);
      routed.revert();
      renderer.destroy();
    },
  );
});

it.for([32, 4096])(
  "hands off %i samples with constant DOM work and no geometry rereads",
  (sampleCount) => {
    const { renderer, scheduler } = createInteractionRenderer(new ElementStore());
    scheduler.runAll();
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: PEN_STYLE,
    });
    const observed = observeHandoffPreview(
      builder.appendBatch(Array.from({ length: sampleCount }, (_, index) => liveSample(index))),
    );
    renderer.updateLiveStroke(observed.preview, PEN_STYLE, "pen");
    const camera = fakeNode(renderer.svg).nodes[1]!;
    const host = camera.nodes.find((node) =>
      node.nodes[0]?.nodes.some((child) => child.tagName === "path"),
    );
    if (host === undefined) throw new Error("Expected a live stroke group.");
    const group = host.nodes[0]!;
    const paths = [...group.nodes];
    const geometry = paths.map((node) => node.attributes.get("d"));
    const builderWork = builder.instrumentation();
    const create = vi.spyOn(group.ownerDocument, "createElementNS");
    const append = vi.spyOn(FakeNode.prototype, "append");
    const insert = vi.spyOn(FakeNode.prototype, "insertBefore");
    const remove = vi.spyOn(FakeNode.prototype, "remove");
    const write = vi.spyOn(FakeNode.prototype, "setAttribute");
    const removeAttribute = vi.spyOn(FakeNode.prototype, "removeAttribute");
    const schedule = vi.spyOn(scheduler, "requestAnimationFrame");
    try {
      renderer.resetInstrumentation();
      observed.reset();
      renderer.commitLiveStroke("bounded-handoff");
      expect(observed.reads()).toBe(0);
      expect(builder.instrumentation()).toEqual(builderWork);
      expect(group.nodes).toEqual(paths);
      for (let index = 0; index < paths.length; index += 1)
        expect(group.nodes[index]).toBe(paths[index]);
      expect(paths.map((node) => node.attributes.get("d"))).toEqual(geometry);
      expect(group.parent).not.toBe(host);
      expect(group.parent?.attributes.get("class")).toContain("inkbook-scene-content");
      expect(create.mock.calls.map(([, tag]) => tag)).toEqual(["g"]);
      expect(append).toHaveBeenCalledTimes(2);
      expect(insert).toHaveBeenCalledTimes(2);
      expect(remove).not.toHaveBeenCalled();
      expect(write.mock.calls).toEqual([["pointer-events", "none"]]);
      expect(removeAttribute.mock.calls).toEqual([["opacity"]]);
      expect(schedule).toHaveBeenCalledOnce();
      expect(scheduler.pendingCount).toBe(1);
      expect(renderer.instrumentation()).toMatchObject({
        geometryBuilds: 0,
        contentGeometryWrites: 0,
        liveChunkNodesCreated: 0,
        liveTailNodesCreated: 0,
        livePreviewUpdates: 0,
        scheduledFrames: 1,
      });
      scheduler.runNext();
      expect(scheduler.pendingCount).toBe(0);
      expect(schedule).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledOnce();
      expect(group.parent).toBeUndefined();
      expect(renderer.instrumentation().liveTailNodesRemoved).toBe(1);
    } finally {
      vi.restoreAllMocks();
      renderer.destroy();
    }
  },
);

function observeHandoffPreview(preview: LiveStrokePreview) {
  let reads = 0;
  const observe = <T extends object>(value: T): T =>
    new Proxy(value, {
      get(target, key, receiver) {
        reads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
  return {
    preview: observe({
      finalizedChunks: observe(preview.finalizedChunks.map((chunk) => observe(chunk))),
      tail: observe(preview.tail),
    }),
    reads: () => reads,
    reset: () => {
      reads = 0;
    },
  };
}

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
  const preview = new CreationPreview(
    livePreviewOptions(
      createBuiltInSettings().toolDefaults,
      activeEditorStoreHistory(store),
      renderer,
      pointerType,
    ),
  );
  let routed: GesturePreview = preview;
  const input = new CoalescedPointerInput(
    liveInputOptions(scheduler, (pointer) => routed.update(pointer), pointerType),
  );
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
