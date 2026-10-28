import { afterEach, expect, it, vi } from "vitest";

import { linearPivot, resolveShapeAnchor } from "../../../../../../src/domain/geometry/public";
import { layoutSelectionHandles } from "../../../../../../src/editor/selection/handles";
import { SelectionFrameSession } from "../../../../../../src/editor/selection/public";
import type { ConnectedPreviewRequest } from "../../../../../../src/rendering/scene/presentation/connected-preview-cohort";
import type { ProgressivePreviewTransform } from "../../../../../../src/rendering/scene/presentation/progressive-element-preview";
import type { InkElementV1 } from "../../../../../../src/domain/schema/public";
import { ElementStore } from "../../../../../../src/domain/store/public";
import {
  ActiveEditorHandleInteraction,
  type ActiveEditorHandleInteractionOptions,
} from "../../../../../../src/obsidian/embeds/active-editor/previews/handle-interaction";
import { ElementSceneStore } from "../../../../../../src/obsidian/embeds/active-editor/scene-store";
import type { SelectionPreviewOptions } from "../../../../../../src/obsidian/embeds/active-editor/previews/selection-preview-contracts";
import { MovePreview } from "../../../../../../src/obsidian/embeds/active-editor/previews/move-preview";
import type { EditableDocumentModel } from "../../../../../../src/obsidian/embeds/document-session/document-model-port";
import { connectionChain } from "../../../../../fixtures/domain/connection-chain";
import {
  activeEditorPreparedHistory,
  activeEditorStoreHistory,
} from "../../../../../fixtures/obsidian/active-editor";
import { elementReplacementPorts } from "../../../../../fixtures/obsidian/element-mutation-ports";
import { rectangle, tableFromRectangle } from "../../../../../unit/domain/store/fixtures";
import { ManualFrameScheduler } from "../../../../../fixtures/obsidian/manual-frame-scheduler";
import { immediateFrameScheduler } from "../../../../../fixtures/obsidian/immediate-frame-scheduler";
import { immediateWorkScheduler } from "../../../../../fixtures/obsidian/immediate-work-scheduler";

afterEach(() => vi.restoreAllMocks());

function fixture(elements: readonly InkElementV1[], selectedId: string | readonly string[]) {
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
    clearProgressiveElementPreviews: vi.fn(),
    setProgressiveElementPreviews:
      vi.fn<
        (
          ids: readonly string[],
          materialize: (id: string) => InkElementV1 | undefined,
          version: number,
          feedback?: unknown,
          purpose?: unknown,
        ) => void
      >(),
    clearPreviewTransforms: vi.fn(),
    flushPointerFeedbackFrame: vi.fn(),
    setElementPreviews: vi.fn<(elements: readonly InkElementV1[], version: number) => void>(),
    setSelectionOverlayPath: vi.fn(),
    setSnapMarkerPath: vi.fn(),
    setOverlayPath: vi.fn(),
    setPreviewTransform: vi.fn(),
    suppressMotionForNextDelta: vi.fn(),
  };
  const selection = () => new Set(typeof selectedId === "string" ? [selectedId] : selectedId);
  return { store, model, history, preparedHistory, sceneStore, renderer, selection };
}

type TestFixture = ReturnType<typeof fixture>;
type HandleOptions = Partial<
  Pick<
    ActiveEditorHandleInteractionOptions,
    "workScheduler" | "frameScheduler" | "layout" | "selectionFrames"
  >
>;

function handles(test: TestFixture, options: HandleOptions = {}) {
  return new ActiveEditorHandleInteraction({
    ...test,
    frameScheduler: immediateFrameScheduler(),
    pageToScreen: (point) => point,
    zoom: () => 1,
    ...options,
  });
}

function sample(point: { readonly x: number; readonly y: number }) {
  return { ...point, pointerId: 1, pointerType: "mouse" as const };
}

function linearHandleFixture(size: number, options: HandleOptions = {}) {
  const elements = connectionChain(size);
  const selected = elements[1]!;
  const test = fixture(elements, selected.id);
  return {
    ...test,
    elements,
    interaction: handles(test, options),
    pointer: sample(selected.start),
  };
}

function dispose(test: TestFixture, interaction?: ActiveEditorHandleInteraction): void {
  interaction?.dispose();
  test.preparedHistory.dispose();
  test.history.dispose();
  test.sceneStore.release();
}

function movePreview(
  test: TestFixture,
  options: Pick<SelectionPreviewOptions, "workScheduler" | "connectionSnapping"> = {},
) {
  return new MovePreview({
    ...test,
    pageToScreen: (point) => point,
    setSelection: vi.fn(),
    ...options,
    start: {
      additive: false,
      kind: "element-move",
      tool: "select",
      pointer: sample({ x: 0, y: 0 }),
    },
  });
}

async function commitMove(test: TestFixture, move: MovePreview): Promise<void> {
  expect(move.commit()).toBe(true);
  await vi.waitFor(() => expect(test.history.commandCount).toBe(1));
}

function refusePreparedMove(test: TestFixture, createMove: () => MovePreview): void {
  test.preparedHistory.dispose();
  const refused = createMove();
  refused.update(sample({ x: 10, y: 10 }));
  expect(refused.commit()).toBe(false);
  expect(test.history.commandCount).toBe(1);
}

function shapeChain(target: ReturnType<typeof rectangle> | ReturnType<typeof tableFromRectangle>) {
  const anchor = { kind: "box" as const, position: "top-left" as const };
  const start = resolveShapeAnchor(target, anchor)!;
  return connectionChain(300).map((element, index) => ({
    ...element,
    start,
    pivot: linearPivot(start, element.end, null),
    startConnection: index === 0 ? { targetId: target.id, anchor } : element.startConnection,
  }));
}

function handlePointer(
  interaction: ActiveEditorHandleInteraction,
  frames: SelectionFrameSession,
  kind: "scale" | "table-header" | "table-column",
) {
  const selected = interaction.selectionGeometry();
  const frame = frames.current(selected);
  const handle = layoutSelectionHandles(selected, { frame, zoom: 1 }).find(
    (entry) => entry.kind === kind && (entry.kind !== "scale" || entry.position === "bottom-right"),
  );
  if (handle === undefined) throw new Error("Expected the requested selection handle.");
  return sample(handle.point);
}

it("publishes a targeted middle-line edit and downstream endpoints in the same pointer frame", () => {
  const test = linearHandleFixture(4);
  const { elements, interaction, pointer } = test;
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
    dispose(test, interaction);
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
    const move = movePreview(test, { workScheduler: scheduler });
    move.update(sample({ x: -500, y: 0 }));
    await commitMove(test, move);
    expect(plan).not.toHaveBeenCalled();
    expect(test.store.get(source.id)?.element).toMatchObject({
      startConnection: {
        targetId: elements[2]!.id,
        anchor: { kind: "linear-endpoint", endpoint: "start" },
      },
    });
  } finally {
    dispose(test);
  }
});

it("routes a single connected move through preparation and keeps an unavailable fallback closed", async () => {
  const elements = connectionChain(3);
  const selected = elements[1]!;
  const test = fixture(elements, selected.id);
  const createMove = () => movePreview(test, { connectionSnapping: false });
  const plan = vi.spyOn(test.store, "planReplacements");
  try {
    const move = createMove();
    move.update(sample({ x: 20, y: 30 }));
    await commitMove(test, move);
    expect(plan).not.toHaveBeenCalled();
    expect(test.store.get(selected.id)?.element).toMatchObject({
      start: selected.start,
      end: { x: 420, y: 130 },
      startConnection: selected.startConnection,
    });
    refusePreparedMove(test, createMove);
    expect(plan).not.toHaveBeenCalled();
  } finally {
    dispose(test);
  }
});

it("retains the prepared follower cohort across continuous large-graph handle updates and cancels stale snapshots", async () => {
  const test = linearHandleFixture(1_000, { workScheduler: immediateWorkScheduler() });
  const { elements, interaction, pointer } = test;
  try {
    expect(interaction.pointerDown(pointer)).toBe(true);
    await Promise.resolve();
    let previous: ((id: string) => InkElementV1 | undefined) | undefined;
    let cohort: readonly string[] | undefined;
    for (const x of [450, 520, 430]) {
      interaction.pointerMove({ ...pointer, x, y: 180 });
      const request = test.renderer.setProgressiveElementPreviews.mock.lastCall!;
      expect(request[4]).toBe("connected");
      expect(request[0]).toHaveLength(998);
      if (cohort !== undefined) expect(request[0]).toBe(cohort);
      cohort = request[0];
      expect(previous?.(elements[999]!.id)).toBeUndefined();
      expect(request[1](elements[999]!.id)).toMatchObject({ start: { x, y: 180 } });
      previous = request[1];
    }
    expect(test.renderer.clearProgressiveElementPreviews).not.toHaveBeenCalled();
    interaction.cancel();
    expect(previous?.(elements[999]!.id)).toBeUndefined();
    expect(test.store.instrumentation.publishedDeltas).toBe(0);
  } finally {
    dispose(test, interaction);
  }
});

it.each(["preparation", "renderer", "layout"] as const)(
  "releases a retained handle snapshot when %s throws during pointer-up",
  async (failure) => {
    const frames = new ManualFrameScheduler();
    const finish = vi.fn();
    const test = linearHandleFixture(300, {
      layout: { begin: vi.fn(), finish, updateBottom: vi.fn() },
      workScheduler: immediateWorkScheduler(),
      frameScheduler: frames,
    });
    const { elements, interaction, pointer } = test;
    try {
      interaction.pointerDown(pointer);
      await Promise.resolve();
      interaction.pointerMove({ ...pointer, x: 450, y: 180 });
      frames.runNext();
      const snapshot = test.renderer.setProgressiveElementPreviews.mock.lastCall![1];
      expect(snapshot(elements[299]!.id)).toBeDefined();
      const commit = vi.spyOn(test.preparedHistory, "commitHandle").mockReturnValue(false);
      const error = new Error("Host boundary failed.");
      const fail = () => {
        throw error;
      };
      if (failure === "preparation") commit.mockImplementation(fail);
      if (failure === "renderer") test.renderer.setElementPreviews.mockImplementation(fail);
      if (failure === "layout") finish.mockImplementation(fail);
      interaction.pointerMove({ ...pointer, x: 520, y: 190 });
      expect(() => interaction.pointerUp(pointer.pointerId)).toThrow(error);
      expect(interaction.activePointerId).toBeUndefined();
      expect(snapshot(elements[299]!.id)).toBeUndefined();
      expect(finish).toHaveBeenCalledOnce();
      expect(test.renderer.clearElementPreviews).toHaveBeenCalled();
      expect(test.store.instrumentation.publishedDeltas).toBe(0);
    } finally {
      dispose(test, interaction);
    }
  },
);

it("prepares a shape-root move and its complete dependent graph without synchronous planning", async () => {
  const target = rectangle();
  const chain = shapeChain(target);
  const test = fixture([target, ...chain], target.id);
  const plan = vi.spyOn(test.store, "planReplacements");
  try {
    const createMove = () => movePreview(test, { workScheduler: immediateWorkScheduler() });
    const move = createMove();
    move.update(sample({ x: 30, y: 40 }));
    await commitMove(test, move);
    expect(plan).not.toHaveBeenCalled();
    expect(test.store.get(target.id)?.element).toMatchObject({ x: 130, y: 140 });
    expect(test.store.get(chain[299]!.id)?.element).toMatchObject({ start: { x: 130, y: 140 } });
    expect(test.store.instrumentation.publishedDeltas).toBe(1);
    refusePreparedMove(test, createMove);
    expect(plan).not.toHaveBeenCalled();
    expect(test.store.instrumentation.publishedDeltas).toBe(1);
  } finally {
    dispose(test);
  }
});

it("moves a large selected connected cohort through lazy previews and one complete commit", async () => {
  const target = rectangle();
  const elements = shapeChain(target).map((element) => ({
    ...element,
    startConnection: {
      targetId: target.id,
      anchor: { kind: "box" as const, position: "top-left" as const },
    },
  }));
  const test = fixture(
    [target, ...elements],
    elements.map(({ id }) => id),
  );
  const move = movePreview(test, {
    workScheduler: immediateWorkScheduler(),
    connectionSnapping: false,
  });
  try {
    await Promise.resolve();
    move.update(sample({ x: 30, y: 40 }));
    expect(test.renderer.setElementPreviews.mock.lastCall![0]).toEqual([]);
    const request = test.renderer.setProgressiveElementPreviews.mock.lastCall!;
    expect(request[0]).toEqual(elements.map(({ id }) => id));
    expect(request[4]).toBe("connected");
    const last = elements[299]!;
    const expected = {
      id: last.id,
      start: last.start,
      end: { x: last.end.x + 30, y: last.end.y + 40 },
      startConnection: last.startConnection,
    };
    expect(request[1](last.id)).toMatchObject(expected);
    expect(test.store.instrumentation.publishedDeltas).toBe(0);
    await commitMove(test, move);
    expect(test.store.instrumentation.publishedDeltas).toBe(1);
    expect(test.store.get(last.id)?.element).toMatchObject(expected);
    expect(test.store.get(target.id)?.element).toEqual(target);
    expect(request[1](last.id)).toBeUndefined();
  } finally {
    dispose(test);
  }
});

it("projects follower anchors from the canonical rotated shape during mixed nonuniform scaling", async () => {
  const target = { ...rectangle(), rotation: 37 };
  const companion = rectangle("00000000-0000-4000-8000-000000000099", 600, 400);
  const anchor = { kind: "box" as const, position: "top-left" as const };
  const initial = resolveShapeAnchor(target, anchor)!;
  const chain = shapeChain(target);
  const test = fixture([target, companion, ...chain], [target.id, companion.id]);
  const selectionFrames = new SelectionFrameSession();
  const interaction = handles(test, { selectionFrames, workScheduler: immediateWorkScheduler() });
  const plan = vi.spyOn(test.store, "planReplacements");
  try {
    const pointer = handlePointer(interaction, selectionFrames, "scale");
    interaction.pointerDown(pointer);
    await Promise.resolve();
    for (const delta of [
      { x: 140, y: -50 },
      { x: 100, y: 80 },
    ]) {
      interaction.pointerMove({ ...pointer, x: pointer.x + delta.x, y: pointer.y + delta.y });
      const request = test.renderer.setProgressiveElementPreviews.mock.lastCall!;
      const canonical = request[1](target.id);
      if (canonical?.kind !== "rectangle") throw new Error("Expected a canonical shape snapshot.");
      const expected = resolveShapeAnchor(canonical, anchor)!;
      const connected = request[4] as ConnectedPreviewRequest;
      const follower = connected.materialize(chain[299]!.id);
      expect(follower).toMatchObject({ start: expected });
      const feedback = request[3] as ProgressivePreviewTransform;
      const affine = feedback.transformBounds!({
        minX: initial.x,
        minY: initial.y,
        maxX: initial.x,
        maxY: initial.y,
      });
      const affinePoint = {
        x: (affine.minX + affine.maxX) / 2,
        y: (affine.minY + affine.maxY) / 2,
      };
      expect(Math.hypot(expected.x - affinePoint.x, expected.y - affinePoint.y)).toBeGreaterThan(1);
      expect(plan).not.toHaveBeenCalled();
    }
  } finally {
    dispose(test, interaction);
  }
});

it.each(["table-header", "table-column"] as const)(
  "keeps %s edits independent of a large connection graph",
  (kind) => {
    const target = tableFromRectangle();
    const chain = shapeChain(target);
    const test = fixture([target, ...chain], target.id);
    const prepared = vi.spyOn(test.preparedHistory, "commitHandle");
    const selectionFrames = new SelectionFrameSession();
    const interaction = handles(test, { selectionFrames, workScheduler: immediateWorkScheduler() });
    const before = test.store.get(chain[299]!.id);
    try {
      const pointer = handlePointer(interaction, selectionFrames, kind);
      test.store.resetInstrumentation();
      expect(interaction.pointerDown(pointer)).toBe(true);
      expect(interaction.pointerMove({ ...pointer, x: pointer.x + 10, y: pointer.y + 10 })).toBe(
        true,
      );
      expect(interaction.pointerUp(pointer.pointerId)).toBe(true);
      expect(test.store.instrumentation.reverseDependencyVisits).toBe(0);
      expect(test.renderer.setProgressiveElementPreviews).not.toHaveBeenCalled();
      expect(prepared).not.toHaveBeenCalled();
      expect(test.store.get(chain[299]!.id)).toBe(before);
      expect(test.history.commandCount).toBe(1);
    } finally {
      dispose(test, interaction);
    }
  },
);
