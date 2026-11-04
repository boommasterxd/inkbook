import { expect, it } from "vitest";
import type { BoxShapeElementV1, PageV1 } from "../../../../../src/domain/schema/public";
import { createSceneFixture } from "../../../../fixtures/rendering/scene";
import {
  FakeSceneStore,
  fakeNode,
  fakeRectangleRecord,
} from "../../../../unit/rendering/scene/fakes";

const PAGE: PageV1 = {
  activeBufferLines: 3,
  background: { type: "none" },
  innerWidth: 2000,
  lockedBufferLines: 1,
  margin: 24.3,
};

function fixture() {
  const store = new FakeSceneStore();
  store.records.set("shape", fakeRectangleRecord("shape", 0, 10));
  const { renderer, scheduler } = createSceneFixture(PAGE, store);
  renderer.setPage(PAGE, 500);
  scheduler.runAll();
  const camera = fakeNode(renderer.svg).nodes[1]!;
  const content = camera.nodes[4]!;
  const motion = camera.nodes.find((node) =>
    node.attributes.get("class")?.includes("inkbook-scene-motion"),
  )!;
  const baseTime = scheduler.time;
  return {
    renderer,
    scheduler,
    content,
    motion,
    frame(time: number) {
      scheduler.time = baseTime + time;
      scheduler.runNext();
    },
    paint(opacity: number) {
      const record = store.records.get("shape")!;
      const before = record.element as BoxShapeElementV1;
      const after = { ...before, style: { ...before.style, outlineOpacity: opacity } };
      store.records.set("shape", {
        ...record,
        element: after,
        paintVersion: record.paintVersion + 1,
      });
      renderer.applyDelta({ affected: [{ id: "shape", before, after, domains: ["paint"] }] });
    },
  };
}

it("preserves the painted composite and canonical node through repeated committed style changes", () => {
  const f = fixture();
  const canonical = f.content.nodes[0]!;
  try {
    f.paint(0.9);
    f.frame(0);
    f.paint(0.8);
    f.frame(0);
    expect(f.motion.nodes).toHaveLength(1);
    for (const [index, opacity] of [0.6, 0.4, 0.2].entries()) {
      const time = 40 * (index + 1);
      f.frame(time);
      const previous = f.motion.nodes.map((node) => ({ node, opacity: node.style.opacity }));
      const canonicalOpacity = canonical.style.opacity;
      expect(Number(canonicalOpacity)).toBeGreaterThan(0);
      expect(Number(canonicalOpacity)).toBeLessThan(1);
      f.paint(opacity);
      f.frame(time);
      expect(f.content.nodes[0]).toBe(canonical);
      const frozen = f.motion.nodes[0]!;
      expect(Number(frozen.attributes.get("stroke-opacity"))).toBeCloseTo(opacity + 0.2);
      expect(frozen.style.opacity).toBe(canonicalOpacity);
      expect(f.motion.nodes.slice(1)).toEqual(previous.map(({ node }) => node));
      for (const entry of previous) expect(entry.node.style.opacity).toBe(entry.opacity);
      expect(canonical.style.opacity).toBe("0");
    }
    f.frame(240);
    f.scheduler.runAll();
    expect(f.content.nodes[0]).toBe(canonical);
    expect(canonical.attributes.get("stroke-opacity")).toBe("0.2");
    expect(canonical.style.opacity).toBeUndefined();
    expect(f.motion.nodes).toHaveLength(0);
    expect(f.renderer.memoryUsage().motionCacheBytes).toBe(0);
  } finally {
    f.renderer.destroy();
  }
});

it.each(["reduced", "input", "dispose"] as const)(
  "releases the complete retargeted visual on %s",
  (reason) => {
    const f = fixture();
    try {
      f.paint(0.8);
      f.frame(0);
      f.frame(40);
      f.paint(0.6);
      f.frame(40);
      const retained = [...f.motion.nodes];
      expect(retained).toHaveLength(2);
      if (reason === "reduced") f.renderer.setReducedMotion(true);
      else if (reason === "input") f.renderer.interruptMotionForPointerDown();
      else f.renderer.destroy();
      expect(retained.every((node) => node.parentNode === null)).toBe(true);
      expect(f.motion.nodes).toHaveLength(0);
      expect(f.renderer.memoryUsage().motionCacheBytes).toBe(0);
      if (reason !== "dispose") expect(f.content.nodes[0]!.style.opacity).toBeUndefined();
    } finally {
      f.renderer.destroy();
    }
  },
);

it("does not replay a style transition when culled content returns", () => {
  const f = fixture();
  try {
    f.renderer.setViewport({ height: 100, left: 0, top: 1000, width: 100 });
    f.scheduler.runAll();
    expect(f.renderer.mountedCount).toBe(0);
    f.paint(0.4);
    f.scheduler.runAll();
    f.renderer.setViewport({ height: 100, left: 0, top: 0, width: 100 });
    f.scheduler.runAll();
    expect(f.renderer.mountedCount).toBe(1);
    expect(f.content.nodes[0]!.attributes.get("stroke-opacity")).toBe("0.4");
    expect(f.content.nodes[0]!.style.opacity).toBeUndefined();
    expect(f.renderer.instrumentation()).toMatchObject({ motionCrossfades: 0, motionEntrances: 0 });
    expect(f.motion.nodes).toHaveLength(0);
  } finally {
    f.renderer.destroy();
  }
});
