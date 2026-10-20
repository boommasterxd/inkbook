import { afterEach, expect, it, vi } from "vitest";

import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { ActiveEditorHandleInteraction } from "../../../../src/obsidian/embeds/active-editor/handle-interaction";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { MovePreview } from "../../../../src/obsidian/embeds/active-editor/move-preview";
import type { EditableDocumentModel } from "../../../../src/obsidian/embeds/document-model-port";
import { connectionChain } from "../../../fixtures/domain/connection-chain";
import {
  activeEditorPreparedHistory,
  activeEditorStoreHistory,
} from "../../../fixtures/obsidian/active-editor";
import { elementReplacementPorts } from "../../../fixtures/obsidian/element-mutation-ports";
import { immediateFrameScheduler } from "../../../fixtures/obsidian/immediate-frame-scheduler";
import { immediateWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";

afterEach(() => vi.restoreAllMocks());

function fixture(elements: readonly InkElementV1[], selectedId: string) {
  const store = new ElementStore(elements);
  let revision = 0;
  const model = {
    store,
    get revision() {
      return revision;
    },
    setGestureActive: vi.fn(),
    ...elementReplacementPorts(store, () => {
      revision += 1;
    }),
  } as unknown as EditableDocumentModel;
  const history = activeEditorStoreHistory(store);
  const preparedHistory = activeEditorPreparedHistory(model, history);
  const sceneStore = new ElementSceneStore(store);
  const renderer = {
    clearElementPreviews: vi.fn(),
    clearPreviewTransforms: vi.fn(),
    flushPointerFeedbackFrame: vi.fn(),
    setElementPreviews: vi.fn<(elements: readonly InkElementV1[], version: number) => void>(),
    setSelectionOverlayPath: vi.fn(),
    setSnapMarkerPath: vi.fn(),
    setOverlayPath: vi.fn(),
    setPreviewTransform: vi.fn(),
    suppressMotionForNextDelta: vi.fn(),
  };
  const selection = () => new Set([selectedId]);
  return { store, model, history, preparedHistory, sceneStore, renderer, selection };
}

it("publishes a targeted middle-line edit and downstream endpoints in the same pointer frame", () => {
  const elements = connectionChain(4);
  const selected = elements[1]!;
  const test = fixture(elements, selected.id);
  const interaction = new ActiveEditorHandleInteraction({
    ...test,
    frameScheduler: immediateFrameScheduler(),
    pageToScreen: (point) => point,
    zoom: () => 1,
  });
  const pointer = { ...selected.start, pointerId: 1, pointerType: "mouse" as const };
  try {
    expect(interaction.pointerDown(pointer)).toBe(true);
    const visits = vi.spyOn(test.store, "visitDependents");
    const plan = vi.spyOn(test.store, "planReplacements");
    expect(interaction.pointerMove({ ...pointer, x: 450, y: 180 })).toBe(true);
    const [preview] = test.renderer.setElementPreviews.mock.lastCall!;
    expect(preview).toMatchObject(
      elements.slice(1).map(({ id }) => ({ id, start: { x: 450, y: 180 } })),
    );
    expect(visits).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
    expect(test.store.instrumentation.publishedDeltas).toBe(0);
  } finally {
    interaction.dispose();
    test.preparedHistory.dispose();
    test.history.dispose();
    test.sceneStore.release();
  }
});

it("prepares a free line snapped onto a linear chain without entering synchronous graph planning", async () => {
  const elements = connectionChain(3);
  const source = {
    ...elements[0]!,
    id: "00000000-0000-4000-8000-000000050000",
    start: { x: 600, y: 100 },
    end: { x: 900, y: 100 },
    pivot: { x: 750, y: 100 },
  };
  const test = fixture([...elements, source], source.id);
  const scheduler = immediateWorkScheduler();
  const plan = vi.spyOn(test.store, "planReplacements");
  try {
    expect(await test.sceneStore.prepareConnections(source.id, scheduler)).toBe(true);
    const move = new MovePreview({
      ...test,
      pageToScreen: (point) => point,
      setSelection: vi.fn(),
      workScheduler: scheduler,
      start: {
        additive: false,
        kind: "element-move",
        tool: "select",
        pointer: { x: 0, y: 0, pointerId: 1, pointerType: "mouse" },
      },
    });
    move.update({ x: -500, y: 0, pointerId: 1, pointerType: "mouse" });
    expect(move.commit()).toBe(true);
    await vi.waitFor(() => expect(test.history.commandCount).toBe(1));
    expect(plan).not.toHaveBeenCalled();
    expect(test.store.get(source.id)?.element).toMatchObject({
      startConnection: {
        targetId: elements[2]!.id,
        anchor: { kind: "linear-endpoint", endpoint: "start" },
      },
    });
  } finally {
    test.preparedHistory.dispose();
    test.history.dispose();
    test.sceneStore.release();
  }
});

it("routes a single connected move through preparation and keeps an unavailable fallback closed", async () => {
  const elements = connectionChain(3);
  const selected = elements[1]!;
  const test = fixture(elements, selected.id);
  const createMove = () =>
    new MovePreview({
      ...test,
      pageToScreen: (point) => point,
      setSelection: vi.fn(),
      connectionSnapping: false,
      start: {
        additive: false,
        kind: "element-move",
        tool: "select",
        pointer: { x: 0, y: 0, pointerId: 1, pointerType: "mouse" },
      },
    });
  const plan = vi.spyOn(test.store, "planReplacements");
  try {
    const move = createMove();
    move.update({ x: 20, y: 30, pointerId: 1, pointerType: "mouse" });
    expect(move.commit()).toBe(true);
    await vi.waitFor(() => expect(test.history.commandCount).toBe(1));
    expect(plan).not.toHaveBeenCalled();
    expect(test.store.get(selected.id)?.element).toMatchObject({
      start: selected.start,
      end: { x: 420, y: 130 },
      startConnection: selected.startConnection,
    });
    test.preparedHistory.dispose();
    const refused = createMove();
    refused.update({ x: 10, y: 10, pointerId: 1, pointerType: "mouse" });
    expect(refused.commit()).toBe(false);
    expect(plan).not.toHaveBeenCalled();
    expect(test.history.commandCount).toBe(1);
  } finally {
    test.preparedHistory.dispose();
    test.history.dispose();
    test.sceneStore.release();
  }
});
