import { describe, expect, it, vi } from "vitest";
import type { BoxShapeElementV1, InkElementV1 } from "../../../../../src/domain/schema/public";
import type { SceneContentRenderer } from "../../../../../src/rendering/scene/content-renderer";
import type { SceneDom } from "../../../../../src/rendering/scene/scene-dom";
import {
  createInstrumentation,
  resetInstrumentation,
} from "../../../../../src/rendering/scene/instrumentation";
import { SceneMotionController } from "../../../../../src/rendering/scene/presentation/scene-motion-controller";
import type { SceneStoreDelta } from "../../../../../src/rendering/scene/types";
import { FakeDocument, FakeNode, fakeRectangleRecord } from "../fakes";

function setup() {
  const document = new FakeDocument();
  const group = new FakeNode(document, "g");
  const instrumentation = createInstrumentation();
  const content = {
    hasMounted: () => true,
    applyElementPreview: vi.fn(),
    clearElementPreview: vi.fn(),
    setElementMotion: vi.fn(),
    readCanonicalStrokePath: vi.fn<SceneContentRenderer["readCanonicalStrokePath"]>(),
  };
  const selection = new FakeNode(document, "path");
  const handles = new FakeNode(document, "path");
  const motion = new SceneMotionController(
    {
      ownerDocument: document,
      motionGroup: group,
      selectionOverlayPath: selection,
      selectionHandlePath: handles,
    } as unknown as SceneDom,
    content as unknown as SceneContentRenderer,
    instrumentation,
  );
  const apply = (id: string, domain: SceneStoreDelta["affected"][number]["domains"][number]) => {
    const element = fakeRectangleRecord(id, 0, 0).element;
    motion.applyDelta([
      {
        id,
        before: domain === "visibility" ? null : element,
        after: element,
        domains: [domain],
      },
    ]);
    return element;
  };
  const assertResources = () => {
    const bytes = group.nodes.reduce((sum, node) => sum + node.attributes.get("d")!.length * 2, 0);
    motion.refreshInstrumentation();
    expect(instrumentation.motionCacheEntries).toBe(group.nodes.length);
    expect(instrumentation.motionCacheBytes).toBe(bytes);
    expect(motion.cacheMemoryUsage()).toBe(bytes);
    expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(group.nodes.length).toBeLessThanOrEqual(256);
  };
  return { motion, group, instrumentation, content, apply, assertResources, selection, handles };
}

it("holds animation progress for repeated or older frame timestamps", () => {
  const { motion, content, selection, handles } = setup();
  const before = fakeRectangleRecord("geometry", 0, 0).element as BoxShapeElementV1;
  const after = { ...before, width: before.width + 100 };
  motion.applyDelta([{ id: "geometry", before, after, domains: ["geometry"] }]);
  motion.applySelectionPath("M 0 0 L 1 1", "M 2 2 L 3 3", "accent");
  motion.applySelectionPath(null, null, "accent");
  const write = (stamp: number) => {
    motion.writeSelectionFeedback(stamp);
    return motion.write(stamp, Infinity, () => 0);
  };
  write(0);
  write(60);
  const preview = content.applyElementPreview.mock.lastCall![0] as BoxShapeElementV1;
  expect(preview.width).toBeGreaterThan(before.width);
  expect(preview.width).toBeLessThan(after.width);
  const opacity = selection.style.opacity;
  expect(Number(opacity)).toBeGreaterThan(0);
  expect(Number(opacity)).toBeLessThan(1);
  for (const stamp of [60, 60, 20, 60]) {
    expect(write(stamp)).toBe(true);
    expect(content.applyElementPreview.mock.lastCall![0]).toEqual(preview);
    expect(selection.style.opacity).toBe(opacity);
    expect(handles.style.opacity).toBe(opacity);
  }
  expect(write(120)).toBe(false);
  expect(selection.attributes.get("d")).toBe("");
  expect(handles.attributes.get("d")).toBe("");
  expect(content.clearElementPreview).toHaveBeenCalledExactlyOnceWith("geometry");
});

describe("motion resource ownership", () => {
  it("maintains mixed visual ownership through capacity eviction, cancellation and reuse", () => {
    const fixture = setup();
    const { motion, apply, assertResources, instrumentation, group } = fixture;
    apply("geometry", "geometry");
    apply("entrance", "visibility");
    motion.bindMountedEntrances(["entrance"], 0);
    for (let index = 0; index < 260; index += 1) {
      const id = String(index);
      const element = apply(id, "paint");
      if (index % 2 === 0) {
        motion.applyDelta([{ id, before: element, after: null, domains: ["visibility"] }]);
      }
      assertResources();
    }
    expect(instrumentation.motionEvictions).toBe(4);
    expect(group.nodes).toHaveLength(256);
    resetInstrumentation(instrumentation);
    assertResources();
    apply("259", "geometry");
    expect(group.nodes).toHaveLength(255);
    assertResources();
    motion.setResourceConstrained(true);
    expect(group.nodes).toHaveLength(0);
    expect(motion.pending).toBe(true);
    assertResources();
    motion.setResourceConstrained(false);
    apply("reused", "paint");
    assertResources();
    motion.setReducedMotion(true);
    expect(motion.pending).toBe(false);
    expect(group.nodes).toHaveLength(0);
    assertResources();
    motion.setReducedMotion(false);
    apply("released", "paint");
    assertResources();
    motion.release();
    motion.release();
    expect(group.nodes).toHaveLength(0);
    assertResources();
  });

  it("releases byte capacity on interruption and natural completion without owning rejected visuals", () => {
    const { motion, content, apply, group, assertResources } = setup();
    const path = { d: "M".repeat(2 * 1024 * 1024), paint: "stroke" as const };
    content.readCanonicalStrokePath.mockReturnValue([path]);
    apply("full", "paint");
    expect(group.nodes).toHaveLength(1);
    assertResources();
    apply("rejected", "paint");
    expect(group.nodes).toHaveLength(1);
    assertResources();
    motion.interruptForPointerDown();
    expect(group.nodes).toHaveLength(0);
    assertResources();
    content.readCanonicalStrokePath.mockReturnValue(undefined);
    const element: InkElementV1 = apply("completed", "paint");
    motion.write(0, Infinity, () => 0);
    motion.write(120, Infinity, () => 0);
    expect(group.nodes).toHaveLength(0);
    assertResources();
    motion.applyDelta([{ id: element.id, before: element, after: null, domains: ["visibility"] }]);
    assertResources();
    motion.release();
    expect(group.nodes).toHaveLength(0);
    assertResources();
  });
});
