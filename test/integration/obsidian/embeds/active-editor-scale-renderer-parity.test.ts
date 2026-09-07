import { describe, expect, it } from "vitest";

import {
  calculateElementBounds,
  buildElementPathParts,
} from "../../../../src/domain/geometry/public";
import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { layoutSelectionHandles } from "../../../../src/editor/selection/public";
import { ActiveEditorHandleInteraction } from "../../../../src/obsidian/embeds/active-editor/handle-interaction";
import { ActiveEditorHistory } from "../../../../src/obsidian/embeds/active-editor/history";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import type { EditableDocumentModel } from "../../../../src/obsidian/embeds/document-model-port";
import { createSceneFixture } from "../../../fixtures/rendering/scene";
import { createAllElementSnapshot } from "../../../unit/persistence/serialization/fixtures";
import { fakeNode } from "../../../unit/rendering/scene/fakes";

function setup(pressureCount: number) {
  const snapshot = createAllElementSnapshot();
  const elements = snapshot.elements.filter((element) => element.kind !== "straight-highlighter");
  const stroke = elements.find((element) => element.kind === "stroke")!;
  if (stroke.kind === "stroke")
    stroke.points = Array.from({ length: pressureCount }, (_, index) => [
      Number((100 + index * 0.1).toFixed(3)),
      250 + (index % 2),
      (index % 10) / 10,
    ]).flat();
  const store = new ElementStore(elements);
  const sceneStore = new ElementSceneStore(store);
  const { renderer, scheduler } = createSceneFixture(snapshot.page, sceneStore);
  const unsubscribe = store.subscribe((delta) =>
    renderer.applyDelta({
      affected: delta.changes.map((change) => ({
        id: change.id,
        domains: change.domains,
        before: (change.before?.element ?? null) as InkElementV1 | null,
        after: (change.after?.element ?? null) as InkElementV1 | null,
      })),
    }),
  );
  const model = {
    store,
    setGestureActive: () => undefined,
    replaceElements: (replacements: readonly InkElementV1[]) => store.replaceMany(replacements),
  } as unknown as EditableDocumentModel;
  const history = new ActiveEditorHistory(model);
  const interaction = new ActiveEditorHandleInteraction({
    model,
    history,
    sceneStore,
    renderer,
    frameScheduler: scheduler,
    pageToScreen: (point) => point,
    zoom: () => 1,
    selection: () => new Set(elements.map(({ id }) => id)),
    preparedHistory: {} as never,
  });
  scheduler.runAll();
  return { elements, store, renderer, scheduler, interaction, history, sceneStore, unsubscribe };
}

describe("mixed element scale commit renderer parity", () => {
  it.each([3, 513, 4096])(
    "retains the committed graphic after resizing mixed tools with %i pressure samples",
    (count) => {
      const fixture = setup(count);
      const { elements, store, renderer, scheduler, interaction, history } = fixture;
      const selected = elements.map((element) => ({
        element,
        bounds: calculateElementBounds(element),
      }));
      const handle = layoutSelectionHandles(selected, { zoom: 1 }).find(
        (candidate) => candidate.kind === "scale" && candidate.position === "bottom-right",
      );
      if (handle?.kind !== "scale") throw new Error("Missing scale handle.");
      const pointer = { ...handle.point, pointerId: 1, pointerType: "mouse" as const, pressure: 0 };
      expect(interaction.pointerDown(pointer)).toBe(true);
      interaction.pointerMove({ ...pointer, x: pointer.x + 120, y: pointer.y + 80 });
      if (count !== 4096) scheduler.runAll();
      expect(interaction.pointerUp(1)).toBe(true);
      scheduler.runAll();
      expect(history.commandCount).toBe(1);
      const committed = elements.map(({ id }) => store.get(id)!.element as InkElementV1);
      expect(committed).not.toEqual(elements);
      const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
      expect(content.nodes.map((node) => node.attributes.get("d"))).toEqual(
        committed.flatMap(buildElementPathParts).map(({ d }) => d),
      );
      expect(content.nodes.every((node) => !node.attributes.has("transform"))).toBe(true);
      interaction.dispose();
      fixture.unsubscribe();
      renderer.destroy();
      fixture.sceneStore.release();
    },
  );
});
