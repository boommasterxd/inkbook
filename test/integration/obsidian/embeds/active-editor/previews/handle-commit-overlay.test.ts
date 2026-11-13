import { expect, it, onTestFinished, vi } from "vitest";
import type { InkElementV1 } from "../../../../../../src/domain/schema/public";
import { ElementStore } from "../../../../../../src/domain/store/public";
import {
  calculateElementBounds,
  rotatePointClockwise,
} from "../../../../../../src/domain/geometry/public";
import {
  SelectionFrameSession,
  selectionOverlayGeometry,
} from "../../../../../../src/editor/selection/public";
import { rotateSelection } from "../../../../../../src/editor/selection/transform/transforms";
import { ActiveEditorHandleInteraction } from "../../../../../../src/obsidian/embeds/active-editor/previews/handle-interaction";
import { PreparedElementHistory } from "../../../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { ElementSceneStore } from "../../../../../../src/obsidian/embeds/active-editor/scene-store";
import type { EditableDocumentModel } from "../../../../../../src/obsidian/embeds/document-session/document-model-port";
import { activeEditorStoreHistory } from "../../../../../fixtures/obsidian/active-editor";
import { elementReplacementPorts } from "../../../../../fixtures/obsidian/element-mutation-ports";
import { immediateFrameScheduler } from "../../../../../fixtures/obsidian/immediate-frame-scheduler";
import { immediateWorkScheduler } from "../../../../../fixtures/obsidian/immediate-work-scheduler";
import { createSceneFixture, sceneDeltaEntries } from "../../../../../fixtures/rendering/scene";
import { textElement } from "../../../../../fixtures/rendering/text";
import { createWorkerSnapshot } from "../../../../../fixtures/persistence/worker-snapshot";
import { connectedLine, rectangle } from "../../../../../unit/domain/store/fixtures";
import { FakeNode, fakeNode } from "../../../../../unit/rendering/scene/fakes";

type Outcome = "commit" | "cancel" | "failure" | "dispose";
const geometry = (element: InkElementV1) => ({ element, bounds: calculateElementBounds(element) });

function descendants(node: FakeNode): FakeNode[] {
  return [node, ...node.nodes.flatMap(descendants)];
}

function gatedModel(store: ElementStore, outcome: Outcome) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const replacement = elementReplacementPorts(store);
  const model = {
    store,
    get revision() {
      return store.mutationVersion;
    },
    ...replacement,
    prepareElementReplacement: async (
      ...args: Parameters<EditableDocumentModel["prepareElementReplacement"]>
    ) => {
      await gate;
      if (outcome === "failure") throw new Error("Preparation failed.");
      return replacement.prepareElementReplacement(...args);
    },
    setGestureActive: vi.fn(),
  } as unknown as EditableDocumentModel;
  return { model, release };
}

function commitFixture(outcome: Outcome) {
  const text = textElement({ x: 100, y: 100, pivot: { x: 200, y: 150 } });
  const base = [text, connectedLine(rectangle(text.id, text.x, text.y))];
  const center = { x: 250, y: 150 };
  const store = new ElementStore(base);
  store.replaceMany(rotateSelection(base, center, 45));
  const elements = base.map(({ id }) => store.get(id)!.element as InkElementV1);
  const sceneStore = new ElementSceneStore(store);
  const { renderer, scheduler } = createSceneFixture(createWorkerSnapshot([]).page, sceneStore);
  renderer.setReducedMotion(true);
  const unsubscribe = store.subscribe((delta) =>
    renderer.applyDelta({ affected: sceneDeltaEntries(delta) }),
  );
  const { model, release } = gatedModel(store, outcome);
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const history = activeEditorStoreHistory(store);
  const prepared = new PreparedElementHistory({
    history,
    model,
    motion: renderer,
    isAttached: () => true,
    onPendingChanged: (pending) => {
      if (!pending) settle();
    },
    workScheduler: immediateWorkScheduler(),
  });
  let interaction: ActiveEditorHandleInteraction | undefined;
  const frames = new SelectionFrameSession(() => interaction?.renderSelection());
  frames
    .transition(frames.current(base.map(geometry)), { kind: "rotate", center, degrees: 45 })!
    .apply();
  const selection = new Set(elements.map(({ id }) => id));
  let zoom = 1;
  interaction = new ActiveEditorHandleInteraction({
    model,
    history,
    preparedHistory: prepared,
    renderer,
    sceneStore,
    selectionFrames: frames,
    selection: () => selection,
    frameScheduler: immediateFrameScheduler(),
    pageToScreen: (point) => ({ x: point.x * zoom, y: point.y * zoom }),
    zoom: () => zoom,
  });
  interaction.renderSelection();
  scheduler.runAll();
  const nodes = descendants(fakeNode(renderer.svg));
  const overlay = nodes.find((node) => node.getAttribute("class") === "inkbook-selection-overlay")!;
  const textRoot = nodes.find((node) => node.getAttribute("class") === "inkbook-native-text")!;
  const handle = selectionOverlayGeometry(
    elements.map(geometry),
    1,
    null,
    frames.current(elements.map(geometry)),
  )!.handles.find(({ kind }) => kind === "rotate")!;
  onTestFinished(() => {
    interaction?.dispose();
    prepared.dispose();
    history.dispose();
    unsubscribe();
    renderer.destroy();
    sceneStore.release();
    store.releasePreparedPressureGeometry();
    release();
  });
  return {
    renderer,
    scheduler,
    store,
    interaction,
    prepared,
    overlay,
    textRoot,
    selection,
    release,
    settled,
    rotate: () => {
      const start = { ...handle.point, pointerId: 1, pointerType: "mouse" as const };
      expect(interaction.pointerDown(start)).toBe(true);
      expect(
        interaction.pointerMove({ ...start, ...rotatePointClockwise(start, center, -75) }),
      ).toBe(true);
      return start.pointerId;
    },
    zoom: () => {
      zoom = 0.75;
      renderer.setCamera({ x: 0, zoom });
      interaction.renderCameraSelection();
    },
  };
}

function overlayAngle(node: FakeNode): number {
  const [x1, y1, x2, y2] = node
    .getAttribute("d")!
    .match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gu)!
    .map(Number);
  return (Math.atan2(y2! - y1!, x2! - x1!) * 180) / Math.PI;
}

function textAngle(node: FakeNode): number {
  const rotations = [...node.getAttribute("transform")!.matchAll(/rotate\(([-\d.e+]+)/gu)];
  return rotations.reduce((angle, match) => angle + Number(match[1]), 0);
}

it.each<Outcome>(["commit", "cancel", "failure"])(
  "keeps the real scene overlay with rotated text until asynchronous %s settles",
  async (outcome) => {
    const fixture = commitFixture(outcome);
    const { renderer, scheduler, store, interaction, prepared, overlay, textRoot } = fixture;
    const pointerId = fixture.rotate();
    const preview = overlay.getAttribute("d");
    expect(overlayAngle(overlay)).toBeCloseTo(-30, 3);
    expect(interaction.pointerUp(pointerId)).toBe(true);
    renderer.flushPointerFeedbackFrame();
    scheduler.runAll();
    expect(overlay.getAttribute("d")).toBe(preview);
    expect(textAngle(textRoot)).toBeCloseTo(-30, 3);
    if (outcome === "cancel") prepared.cancel();
    fixture.release();
    await fixture.settled;
    renderer.flushPointerFeedbackFrame();
    scheduler.runAll();
    expect(overlayAngle(overlay)).toBeCloseTo(outcome === "commit" ? -30 : 45, 3);
    expect(textAngle(textRoot)).toBeCloseTo(outcome === "commit" ? -30 : 45, 3);
    const text = store.get([...fixture.selection][0]!)!.element;
    expect(text.rotation).toBe(outcome === "commit" ? -30 : 45);
    const beforeZoom = overlay.getAttribute("d");
    fixture.zoom();
    scheduler.runAll();
    expect(overlay.getAttribute("d")).not.toBe(beforeZoom);
    fixture.selection.clear();
    interaction.renderSelection();
    scheduler.runAll();
    expect(overlay.getAttribute("d")).toBe("");
  },
);

it("does not write a late settled overlay after the handle interaction is disposed", async () => {
  const fixture = commitFixture("dispose");
  fixture.interaction.pointerUp(fixture.rotate());
  fixture.interaction.dispose();
  const writes = vi.spyOn(fixture.renderer, "setSelectionOverlayPath");
  fixture.prepared.cancel();
  fixture.release();
  await fixture.settled;
  expect(writes).not.toHaveBeenCalled();
  writes.mockRestore();
});
