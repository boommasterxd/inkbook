import * as strokeGeometry from "../../../../../src/domain/geometry/stroke-path";
import { describe, expect, it, vi } from "vitest";

import type { InkElementV1, PageV1 } from "../../../../../src/domain/schema/public";
import { ElementStore } from "../../../../../src/domain/store/public";
import { moveSelectionTimeSliced } from "../../../../../src/editor/selection/public";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import type { SvgSceneRenderer } from "../../../../../src/rendering/scene";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { fakeNode } from "../../../../unit/rendering/scene/fakes";
import { createSceneFixture } from "../../../../fixtures/rendering/scene";
import { CheckpointSliceScheduler } from "../../../domain/domain-scenarios";

const ELEMENT_COUNT = 10_000;
const HANDOFF_TRANSITIONS = 2;
const PAGE: PageV1 = {
  activeBufferLines: 3,
  background: { type: "none" },
  innerWidth: 2_000,
  lockedBufferLines: 1,
  margin: 24.3,
};

describe("selection preview handoff performance", () => {
  it("hands off 10,000 elements without redundant geometry transitions", async () => {
    const elements = Array.from({ length: ELEMENT_COUNT }, (_, index) => indexedStroke(index));
    const ids = elements.map(({ id }) => id);
    const store = new ElementStore(elements);
    const { renderer, scheduler } = createSceneFixture(PAGE, new ElementSceneStore(store), {
      height: 100,
      left: 0,
      top: 0,
      width: 100,
    });
    renderer.setPage(PAGE, 200_000);
    scheduler.runAll();
    verifyBoundedSelectionFrame(renderer, store);
    const centers = vi.spyOn(strokeGeometry, "strokeCenterAt");
    let notifications = 0;
    const unsubscribe = store.subscribe((delta) => {
      notifications += 1;
      const affected = delta.changes.map((change) => ({
        id: change.id,
        domains: change.domains,
        before: recordElement(change.before),
        after: recordElement(change.after),
      }));
      renderer.applyDelta({ affected });
    });

    for (let run = 0; run < HANDOFF_TRANSITIONS; run += 1) {
      const current = ids.map((id) => store.get(id)?.element as InkElementV1);
      const distance = run % 2 === 0 ? 0.001 : -0.001;
      const preparationScheduler = new CheckpointSliceScheduler();
      const replacements = await moveSelectionTimeSliced(
        current,
        { x: distance, y: distance },
        preparationScheduler,
      );
      if (replacements === null) throw new Error("Selection materialization was cancelled.");
      const prepared = await store.prepareElementReplacement(replacements, preparationScheduler);
      if (prepared.status !== "prepared" || prepared.token === null) {
        throw new Error("Selection replacement was not prepared.");
      }

      renderer.setPreviewTransform(
        ids,
        `translate(${String(distance)} ${String(distance)})`,
        run + 1,
      );
      scheduler.runAll();
      const handoff = renderer.beginPreviewCommit();
      renderer.clearPreviewTransforms();
      expect(handoff.arm(ids)).toBe(true);
      renderer.resetInstrumentation();
      store.resetInstrumentation();
      const result = store.commitPreparedElementReplacement(prepared.token);
      expect(result.status).toBe("committed");
      expect(result.delta?.changes).toHaveLength(ELEMENT_COUNT);
      expect(renderer.instrumentation().motionGeometryTransitions).toBe(0);
      expect(store.instrumentation.fullStoreScans).toBe(0);
      expect(store.instrumentation.bandScans).toBe(0);
      expect(scheduler.pendingCount).toBe(1);
      scheduler.runAll();
      expect(transformedContentCount(renderer)).toBe(run === 0 ? renderer.mountedCount : 0);
      expect(centers).not.toHaveBeenCalled();
    }

    centers.mockRestore();
    unsubscribe();
    renderer.destroy();
    expect(notifications).toBe(HANDOFF_TRANSITIONS);
  }, 180_000);
});

function verifyBoundedSelectionFrame(renderer: SvgSceneRenderer, store: ElementStore): void {
  const overlay = fakeNode(renderer.svg).nodes[2]!;
  const frame = overlay.nodes.find(
    ({ attributes }) => attributes.get("class") === "inkbook-selection-overlay",
  )!;
  expect(frame.attributes.has("clip-path")).toBe(false);
  const writes = vi.spyOn(frame, "setAttribute");
  const reads = vi.spyOn(store, "get");
  renderer.resetInstrumentation();
  const first = "M 0 0 L 100 0 L 100 50 L 0 50 Z";
  const moved = "M 1 1 L 101 1 L 101 51 L 1 51 Z";
  for (const path of [first, first, moved, moved]) {
    renderer.setSelectionOverlayPath(path);
    renderer.flushPointerFeedbackFrame();
  }
  // Each update may write fill and motion state; geometry changes only twice.
  expect(writes.mock.calls.length).toBeLessThanOrEqual(10);
  expect(writes.mock.calls.filter(([name]) => name === "d")).toEqual([
    ["d", first],
    ["d", moved],
  ]);
  expect(reads).not.toHaveBeenCalled();
  expect(renderer.instrumentation()).toMatchObject({
    contentAttributeWrites: 0,
    geometryBuilds: 0,
    spatialQueries: 0,
  });
  writes.mockRestore();
  reads.mockRestore();
}

function transformedContentCount(renderer: SvgSceneRenderer): number {
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  return content.nodes.filter(({ attributes }) => attributes.has("transform")).length;
}

function recordElement(record: { readonly element: unknown } | null): InkElementV1 | null {
  return record === null ? null : (record.element as InkElementV1);
}
