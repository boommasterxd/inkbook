import { expect, it, vi } from "vitest";

import { MAX_STROKE_POINTS } from "../../../../../src/domain/schema/public";
import type { StrokeStyleV1 } from "../../../../../src/domain/schema/public";
import { ElementStore } from "../../../../../src/domain/store/public";
import {
  LiveStrokeBuilder,
  type LiveStrokePreview,
} from "../../../../../src/editor/tools/live-stroke";
import { fakeNode, FakeNode } from "../../../../unit/rendering/scene/fakes";
import {
  createInteractionRenderer,
  createLivePressureSample,
  LIVE_PRESSURE_STYLE,
  LIVE_STROKE_FRAME_COUNT,
  LIVE_STROKE_SAMPLES_PER_FRAME,
} from "../interaction-refresh-profile-fixture";

// Pen pressure geometry is independent of sample timing; use the invariant 120 Hz fixture.
const SAMPLE_INTERVAL_MS = 1_000 / 120;

it.for(["smooth", "dense zigzag"] as const)(
  "bounds %s live pressure-stroke work across a growing stroke",
  (shape) => {
    const { renderer, scheduler } = createInteractionRenderer(new ElementStore());
    scheduler.runAll();
    const style: StrokeStyleV1 = {
      ...LIVE_PRESSURE_STYLE,
      width: shape === "dense zigzag" ? 22 : LIVE_PRESSURE_STYLE.width,
    };
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style,
    });

    for (let frame = 0; frame < LIVE_STROKE_FRAME_COUNT; frame += 1) {
      const preview = builder.appendBatch(
        Array.from({ length: LIVE_STROKE_SAMPLES_PER_FRAME }, (_, sample) =>
          createLivePressureSample(
            frame * LIVE_STROKE_SAMPLES_PER_FRAME + sample,
            SAMPLE_INTERVAL_MS,
            shape === "dense zigzag",
          ),
        ),
      );
      renderer.updateLiveStroke(preview, style, "pen");
    }

    expect(renderer.instrumentation()).toMatchObject({
      livePreviewUpdates: LIVE_STROKE_FRAME_COUNT,
      geometryBuilds: 0,
      contentGeometryWrites: 0,
      liveTailNodesCreated: 1,
    });
    expect(renderer.instrumentation().liveMaximumTailNodes).toBe(1);
    renderer.destroy();
  },
);

it.for([32, MAX_STROKE_POINTS])(
  "hands off %i samples with constant DOM work and no geometry rereads",
  (sampleCount) => {
    const { renderer, scheduler } = createInteractionRenderer(new ElementStore());
    scheduler.runAll();
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: LIVE_PRESSURE_STYLE,
    });
    for (let start = 0; start < sampleCount; start += 4096) {
      builder.appendBatch(
        Array.from({ length: Math.min(4096, sampleCount - start) }, (_, index) =>
          createLivePressureSample(start + index, SAMPLE_INTERVAL_MS),
        ),
      );
    }
    const observed = observeHandoffPreview(builder.preview());
    renderer.updateLiveStroke(observed.preview, LIVE_PRESSURE_STYLE, "pen");
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
