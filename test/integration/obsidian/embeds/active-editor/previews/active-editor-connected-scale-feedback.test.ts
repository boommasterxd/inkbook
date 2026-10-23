import { describe, expect, it, vi } from "vitest";
import { buildElementPathParts } from "../../../../../../src/domain/geometry/public";
import { ElementStore } from "../../../../../../src/domain/store/public";
import { SelectionFrameSession } from "../../../../../../src/editor/selection/public";
import { layoutSelectionHandles } from "../../../../../../src/editor/selection/handles";
import { ActiveEditorHandleInteraction } from "../../../../../../src/obsidian/embeds/active-editor/previews/handle-interaction";
import { ActiveEditorHistory } from "../../../../../../src/obsidian/embeds/active-editor/history";
import type { PreparedElementHistory } from "../../../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { ElementSceneStore } from "../../../../../../src/obsidian/embeds/active-editor/scene-store";
import type { EditableDocumentModel } from "../../../../../../src/obsidian/embeds/document-session/document-model-port";
import { indexedStroke } from "../../../../../fixtures/editor/stroke";
import { immediateFrameScheduler } from "../../../../../fixtures/obsidian/immediate-frame-scheduler";
import { createSceneFixture } from "../../../../../fixtures/rendering/scene";
import { connectedLine, rectangle } from "../../../../../unit/domain/store/fixtures";
import { createAllElementSnapshot } from "../../../../../unit/persistence/serialization/fixtures";
import { fakeNode } from "../../../../../unit/rendering/scene/fakes";

function setup() {
  const target = rectangle();
  const strokes = Array.from({ length: 300 }, (_, index) => {
    const element = indexedStroke(index);
    return { ...element, points: [1000, 500, 0.5, 1002, 502, 0.75], pivot: { x: 1001, y: 501 } };
  });
  const linear = connectedLine(target);
  const store = new ElementStore([target, ...strokes]);
  const sceneStore = new ElementSceneStore(store);
  const scene = createSceneFixture(createAllElementSnapshot().page, sceneStore);
  scene.scheduler.runAll();
  // Mount the connected path after the pressure roots so snapshot selection cannot include it.
  store.create(linear);
  scene.renderer.applyDelta({
    affected: [
      { id: linear.id, before: null, after: linear, domains: ["geometry", "visibility", "order"] },
    ],
  });
  scene.scheduler.runAll();
  const model = { store, setGestureActive: vi.fn() } as unknown as EditableDocumentModel;
  const selectionFrames = new SelectionFrameSession();
  const selection = new Set([...strokes.map(({ id }) => id), linear.id]);
  const interaction = new ActiveEditorHandleInteraction({
    frameScheduler: immediateFrameScheduler(),
    history: new ActiveEditorHistory(model),
    model,
    pageToScreen: (point) => point,
    preparedHistory: {} as PreparedElementHistory,
    renderer: scene.renderer,
    sceneStore,
    selection: () => selection,
    selectionFrames,
    zoom: () => 1,
  });
  return { ...scene, interaction, linear, sceneStore, selectionFrames };
}

describe("connected selected scale feedback", () => {
  it("keeps a fixed endpoint exact beyond the 256-snapshot cohort without applying scale twice", () => {
    const { renderer, scheduler, interaction, linear, sceneStore, selectionFrames } = setup();
    const selected = interaction.selectionGeometry();
    const frame = selectionFrames.current(selected)!;
    const handle = layoutSelectionHandles(selected, { frame, zoom: 1 }).find(
      (entry) => entry.kind === "scale" && entry.position === "bottom-right",
    );
    if (handle === undefined) throw new Error("Missing scale handle");
    const pointer = { ...handle.point, pointerId: 1, pointerType: "mouse" as const };
    const lineNode = fakeNode(renderer.svg).nodes[1]!.nodes[4]!.nodes.find(
      (node) => node.attributes.get("d") === buildElementPathParts(linear)[0]!.d,
    )!;
    const original = new Map(lineNode.attributes);
    const exact = vi.spyOn(renderer, "setElementPreviews");
    const writes = vi.spyOn(renderer, "flushPointerFeedbackFrame");
    const publish = renderer.setProgressiveElementPreviews.bind(renderer);
    const materialized: string[] = [];
    const progressive = vi
      .spyOn(renderer, "setProgressiveElementPreviews")
      .mockImplementation((ids, materialize, version, feedback) =>
        publish(
          ids,
          (id) => {
            materialized.push(id);
            return materialize(id);
          },
          version,
          feedback,
        ),
      );
    try {
      expect(interaction.pointerDown(pointer)).toBe(true);
      expect(interaction.pointerMove({ ...pointer, x: pointer.x + 100, y: pointer.y + 100 })).toBe(
        true,
      );
      const preview = exact.mock.lastCall?.[0].find(({ id }) => id === linear.id);
      if (preview?.kind !== "line") throw new Error("Missing connected line preview");
      expect(preview.start).toEqual(linear.start);
      expect(preview.end).not.toEqual(linear.end);
      expect(writes).toHaveBeenCalled();
      expect(lineNode.attributes.get("d")).toBe(buildElementPathParts(preview)[0]!.d);
      expect(lineNode.attributes.has("transform")).toBe(false);
      expect(progressive.mock.lastCall?.[0]).not.toContain(linear.id);
      scheduler.runAll();
      expect(new Set(materialized).size).toBe(256);
      expect(materialized).not.toContain(linear.id);
      expect(lineNode.attributes.has("transform")).toBe(false);
      interaction.cancel();
      scheduler.runAll();
      expect(lineNode.attributes).toEqual(original);
    } finally {
      progressive.mockRestore();
      writes.mockRestore();
      exact.mockRestore();
      interaction.dispose();
      renderer.destroy();
      sceneStore.release();
    }
  });
});
