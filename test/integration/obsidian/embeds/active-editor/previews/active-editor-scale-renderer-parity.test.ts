import {
  strokeLocalGeometry,
  strokeWorldPoint,
} from "../../../../../../src/domain/geometry/stroke-position";
import { describe, expect, it } from "vitest";

import {
  calculateElementBounds,
  buildElementPathParts,
} from "../../../../../../src/domain/geometry/public";
import type { InkElementV1 } from "../../../../../../src/domain/schema/public";
import { ElementStore } from "../../../../../../src/domain/store/public";
import { layoutSelectionHandles } from "../../../../../../src/editor/selection/handles";

import { ActiveEditorHandleInteraction } from "../../../../../../src/obsidian/embeds/active-editor/previews/handle-interaction";
import { ActiveEditorHistory } from "../../../../../../src/obsidian/embeds/active-editor/history";
import { ElementSceneStore } from "../../../../../../src/obsidian/embeds/active-editor/scene-store";
import type { EditableDocumentModel } from "../../../../../../src/obsidian/embeds/document-session/document-model-port";
import { createSceneFixture } from "../../../../../fixtures/rendering/scene";
import { createAllElementSnapshot } from "../../../../../unit/persistence/serialization/fixtures";
import { fakeNode, type FakeNode } from "../../../../../unit/rendering/scene/fakes";
import type { StoreDelta } from "../../../../../../src/domain/store/public";
import type { SceneStoreDelta } from "../../../../../../src/rendering/scene/types";

/** Adapt real store publications without introducing a different mutation or rendering path. */
function sceneStoreDelta(delta: StoreDelta): SceneStoreDelta {
  return {
    affected: delta.changes.map((change) => ({
      id: change.id,
      domains: change.domains,
      before: (change.before?.element ?? null) as InkElementV1 | null,
      after: (change.after?.element ?? null) as InkElementV1 | null,
    })),
  };
}

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
  const unsubscribe = store.subscribe((delta) => renderer.applyDelta(sceneStoreDelta(delta)));
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
    frameScheduler: scheduler.workScheduler,
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
      assertCommittedGraphic(content, committed);
      interaction.dispose();
      fixture.unsubscribe();
      renderer.destroy();
      fixture.sceneStore.release();
    },
  );
});

function assertCommittedGraphic(content: FakeNode, elements: readonly InkElementV1[]): void {
  const rendered = content.nodes.flatMap((node) =>
    (node.nodes.length > 0 ? node.nodes : [node]).map((path) => ({
      d: path.attributes.get("d"),
      transform:
        [
          node.attributes.get("transform"),
          path === node ? undefined : path.attributes.get("transform"),
        ]
          .filter(Boolean)
          .join(" ") || undefined,
    })),
  );
  let cursor = 0;
  for (const element of elements) {
    const local = element.kind === "stroke" ? strokeLocalGeometry(element) : element;
    const expected = buildElementPathParts(local);
    const offset = element.kind === "stroke" ? element.offset : undefined;
    const transform =
      offset === undefined || (offset.x === 0 && offset.y === 0)
        ? undefined
        : `translate(${offset.x} ${offset.y})`;
    const actual = rendered.slice(cursor, cursor + expected.length);
    expect(actual).toEqual(expected.map(({ d }) => ({ d, transform })));
    if (element.kind === "stroke" && local.kind === "stroke") {
      // Check world placement from the actual SVG transform, including rotation around the
      // world pivot. Comparing only local path bytes would miss a missing/doubled correction.
      const translation = actual[0]?.transform?.match(/^translate\(([-\d.]+) ([-\d.]+)\)$/);
      const x = Number(translation?.[1] ?? 0);
      const y = Number(translation?.[2] ?? 0);
      for (let index = 0; index < element.points.length; index += 3) {
        const sample = { x: element.points[index]!, y: element.points[index + 1]! };
        const localPoint = strokeWorldPoint(local, sample);
        const worldPoint = strokeWorldPoint(element, sample);
        expect(localPoint.x + x).toBeCloseTo(worldPoint.x, 3);
        expect(localPoint.y + y).toBeCloseTo(worldPoint.y, 3);
      }
    }
    cursor += expected.length;
  }
  expect(cursor).toBe(rendered.length);
}
