import { ActiveEditorHistory } from "../../../src/obsidian/embeds/active-editor/history";
import * as transforms from "../../../src/editor/selection/transforms";
import { expect, it, vi } from "vitest";
import { ElementStore } from "../../../src/domain/store/public";
import { MAX_STROKE_POINTS, type InkElementV1 } from "../../../src/domain/schema/public";
import { ActiveEditorHandleInteraction } from "../../../src/obsidian/embeds/active-editor/handle-interaction";
import type { HandleInteractionRenderer } from "../../../src/obsidian/embeds/active-editor/handle-presentation";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import type { EditableDocumentModel } from "../../../src/obsidian/embeds/document-model-port";
import { indexedStroke } from "../../fixtures/editor/stroke";
import { ManualFrameScheduler } from "../../fixtures/obsidian/manual-frame-scheduler";
import { createSelectionPreviewRenderer } from "../../fixtures/obsidian/selection-preview-renderer";
import * as bounds from "../../../src/domain/geometry/bounds";
import {
  SelectionHandleSession,
  selectionOverlayGeometry,
} from "../../../src/editor/selection/public";
import { immediateWorkScheduler } from "../../fixtures/obsidian/immediate-work-scheduler";
import { activeEditorPreparedHistory } from "../../fixtures/obsidian/active-editor";
import {
  elementMutationPorts,
  elementReplacementPorts,
} from "../../fixtures/obsidian/element-mutation-ports";
import { createStandardRuntimeDomainFixture } from "../domain/standard-domain-fixture";
import { ActiveDocumentHistory } from "../../../src/obsidian/embeds/active-editor/document-history";
import { arrangeSelectionAvailability } from "../../../src/obsidian/embeds/active-editor/controller-elements";
import * as strokePosition from "../../../src/domain/geometry/stroke-position";

function fixture(elements: readonly InkElementV1[]) {
  const store = new ElementStore(elements);
  const sceneStore = new ElementSceneStore(store);
  const state = { selection: new Set(elements.map(({ id }) => id)), revision: 0, zoom: 1 };
  const renderer = {
    ...createSelectionPreviewRenderer(),
    clearElementPreviews: vi.fn(),
    setElementPreviews: vi.fn(),
    setSelectionOverlayPath: vi.fn<HandleInteractionRenderer["setSelectionOverlayPath"]>(),
    setSnapMarkerPath: vi.fn(),
    flushPointerFeedbackFrame: vi.fn(),
  };
  const interaction = new ActiveEditorHandleInteraction({
    frameScheduler: new ManualFrameScheduler(),
    history: {} as never,
    preparedHistory: {} as never,
    model: {
      store,
      setGestureActive: vi.fn(),
      get revision() {
        return state.revision;
      },
    } as unknown as EditableDocumentModel,
    pageToScreen: (point) => ({ x: point.x * state.zoom + 10, y: point.y * state.zoom }),
    renderer,
    sceneStore,
    selection: () => state.selection,
    zoom: () => state.zoom,
  });
  return { interaction, state, renderer, sceneStore };
}

function largeSelectionFixture() {
  const elements = Array.from({ length: 10_000 }, (_, index) => indexedStroke(index));
  const test = fixture(elements);
  return { elements, test, read: vi.spyOn(test.sceneStore, "get") };
}

it("reprojects 10,000 selected elements without rereading them until selection or revision changes", () => {
  const { elements, test, read } = largeSelectionFixture();
  try {
    test.interaction.renderCameraSelection();
    expect(read).toHaveBeenCalledTimes(elements.length);
    read.mockClear();
    for (const zoom of [1, 2, 0.5]) {
      test.state.zoom = zoom;
      test.interaction.renderCameraSelection();
    }
    expect(read).not.toHaveBeenCalled();
    test.state.revision += 1;
    test.interaction.renderCameraSelection();
    expect(read).toHaveBeenCalledTimes(elements.length);
    read.mockClear();
    test.state.selection = new Set([elements[0]!.id]);
    test.interaction.renderCameraSelection();
    expect(read).toHaveBeenCalledTimes(1);
    test.state.selection = new Set();
    test.interaction.renderCameraSelection();
    expect(test.renderer.setSelectionOverlayPath).toHaveBeenLastCalledWith(null, "accent", null);
  } finally {
    read.mockRestore();
    test.interaction.dispose();
    test.sceneStore.release();
  }
});

it("restores a cancelled 10,000-stroke handle preview from retained selection geometry", () => {
  const { elements, test, read } = largeSelectionFixture();
  try {
    test.interaction.renderSelection();
    const geometry = selectionOverlayGeometry(
      elements.map((element) => ({ element, bounds: bounds.calculateElementBounds(element) })),
      1,
    );
    const handle = geometry?.handles.find(
      (candidate) => candidate.kind === "scale" && candidate.position === "bottom-right",
    );
    if (handle === undefined) throw new Error("Expected a resize handle.");
    const pointer = { ...handle.point, pointerId: 1, pointerType: "mouse" as const };
    expect(test.interaction.pointerDown(pointer)).toBe(true);
    read.mockClear();

    expect(test.interaction.cancel(pointer.pointerId)).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(test.renderer.setSelectionOverlayPath).toHaveBeenCalled();
  } finally {
    read.mockRestore();
    test.interaction.dispose();
    test.sceneStore.release();
  }
});

it("reuses a rotated stroke outline for camera changes without recalculating sample bounds", () => {
  const stroke = {
    ...indexedStroke(0),
    rotation: 37,
    points: Array.from({ length: 250 }, (_, i) => [i, i % 7, 0.5]).flat(),
  };
  const test = fixture([stroke]);
  const calculate = vi.spyOn(bounds, "calculateElementBounds");
  try {
    test.interaction.renderSelection();
    const before = test.renderer.setSelectionOverlayPath.mock.lastCall;
    expect(calculate).toHaveBeenCalled();
    calculate.mockClear();
    test.state.zoom = 2;
    test.interaction.renderCameraSelection();
    expect(test.renderer.setSelectionOverlayPath.mock.lastCall).not.toEqual(before);
    test.state.zoom = 1;
    test.interaction.renderCameraSelection();
    const restored = test.renderer.setSelectionOverlayPath.mock.lastCall;
    expect(restored?.slice(0, 2)).toEqual(before?.slice(0, 2));
    const numbers = (value: string) => value.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const expectedHandles = numbers(before![2]!);
    const actualHandles = numbers(restored![2]!);
    expect(actualHandles).toHaveLength(expectedHandles.length);
    actualHandles.forEach((value, index) => expect(value).toBeCloseTo(expectedHandles[index]!, 9));
    expect(calculate).not.toHaveBeenCalled();
  } finally {
    calculate.mockRestore();
    test.interaction.dispose();
    test.sceneStore.release();
  }
});

it.each(
  [false, true].flatMap((asynchronous) =>
    (["move", "rotate", "scale"] as const).map((kind) => ({ asynchronous, kind })),
  ),
)(
  "reuses 10,000 owned stroke records through $kind history: async=$asynchronous",
  async ({ asynchronous, kind }) => {
    const { store, originals } = await hydratedStandardStrokes(false);
    const elements = originals.map(({ element }) => element) as InkElementV1[];
    const model = { store, ...elementReplacementPorts(store) } as EditableDocumentModel;
    const history = new ActiveEditorHistory(model);
    const prepared = activeEditorPreparedHistory(model, history);
    let pointBuilds = 0;
    const actualPoint = strokePosition.strokeWorldPoint;
    const geometry = vi.spyOn(strokePosition, "strokeWorldPoint").mockImplementation((...args) => {
      pointBuilds += 1;
      // Count every production call, retaining only a bounded batch of spy records.
      if (pointBuilds % 1_024 === 0) geometry.mockClear();
      return actualPoint(...args);
    });
    const materialize = vi.spyOn(store, "materializeBandOrder");
    try {
      if (asynchronous) {
        const session = new SelectionHandleSession({
          action:
            kind === "move"
              ? { kind }
              : kind === "rotate"
                ? { kind, center: { x: 0, y: 0 }, opposite: { x: 1, y: 0 }, referenceRotation: 0 }
                : { kind, anchor: { x: 0, y: 0 }, position: "bottom-right", rotation: 0 },
          elements,
          planner: store,
          startPointer: { x: 1, y: 1 },
        });
        session.update(kind === "rotate" ? { x: -1, y: 1 } : { x: 3, y: 4 });
        const completed = new Promise<boolean>((resolve) => {
          expect(prepared.commitHandle(session, resolve)).toBe(true);
        });
        expect(await completed).toBe(true);
      } else {
        const replacements =
          kind === "move"
            ? transforms.moveSelection(elements, { x: 2, y: 3 })
            : kind === "rotate"
              ? transforms.rotateSelection(elements, { x: 0, y: 0 }, 90)
              : elements.map((element) =>
                  transforms.scaleElement(element, { x: 0, y: 0 }, { x: 2, y: 2 }),
                );
        expect(history.replace(elements, replacements)).toBe(true);
      }
      const changed = originals.map(({ element }) => store.get(element.id)!);
      const committedPointBuilds = pointBuilds;
      expect(await history.undoAsync()).toBe(true);
      for (const original of originals) {
        const restored = store.get(original.element.id)!;
        expect(restored.element).toBe(original.element);
        expect(restored.bounds).toBe(original.bounds);
        expect(restored.geometryVersion).toBeGreaterThan(changed[0]!.geometryVersion);
      }
      expect(await history.redoAsync()).toBe(true);
      for (const record of changed) {
        const restored = store.get(record.element.id)!;
        expect(restored.element).toBe(record.element);
        expect(restored.bounds).toBe(record.bounds);
        expect(restored.geometryVersion).toBeGreaterThan(record.geometryVersion + 1);
      }
      // Scale also measures the preview frame and stabilized anchor before Store geometry.
      const boundsPasses = kind === "move" ? 0 : kind === "scale" && asynchronous ? 3 : 1;
      expect(committedPointBuilds).toBe(boundsPasses * 500_000);
      expect(pointBuilds).toBe(committedPointBuilds);
      expect(materialize).not.toHaveBeenCalled();
      expect(store.instrumentation.bandScans).toBe(0);
      expect(store.instrumentation.snapshotMaterializations).toBe(0);
      expect(history.commandCount).toBe(1);
    } finally {
      geometry.mockRestore();
      materialize.mockRestore();
      prepared.dispose();
      history.dispose();
    }
  },
);

it.each([10, 10_000])(
  "reads only one selected element for Arrange availability in a %s-stroke store",
  (size) => {
    const elements = Array.from({ length: size }, (_, index) => indexedStroke(index));
    const store = new ElementStore(elements);
    const sceneStore = new ElementSceneStore(store);
    const read = vi.spyOn(sceneStore, "get");
    const materialize = vi.spyOn(sceneStore, "materializeBandOrder");
    store.resetInstrumentation();
    try {
      expect(arrangeSelectionAvailability(sceneStore, new Set([elements[1]!.id]))).toEqual({
        "bring-forward": true,
        "bring-to-front": true,
        "send-backward": true,
        "send-to-back": true,
      });
      expect(read).toHaveBeenCalledExactlyOnceWith(elements[1]!.id);
      expect(materialize).not.toHaveBeenCalled();
      expect(store.instrumentation.bandScans).toBe(0);
      expect(store.instrumentation.fullStoreScans).toBe(0);
    } finally {
      read.mockRestore();
      materialize.mockRestore();
      sceneStore.release();
    }
  },
);

async function hydratedStandardStrokes(maximum: boolean) {
  const source = maximum
    ? [
        {
          ...indexedStroke(0),
          points: Array.from({ length: MAX_STROKE_POINTS * 3 }, (_, index) =>
            index % 3 === 2 ? 0.5 : Math.floor(index / 3),
          ),
        },
      ]
    : createStandardRuntimeDomainFixture().elements.slice(0, 10_000);
  const elements = source.map((element, index) =>
    element.kind === "stroke" && index % 2 === 0
      ? {
          ...element,
          tool: "highlighter" as const,
          style: { ...element.style, pressureEnabled: false },
        }
      : element,
  );
  const builder = ElementStore.createBuilder({
    shouldYield: () => false,
    yieldControl: () => Promise.resolve(),
  });
  await builder.appendOwnedRuntime(elements);
  const store = await builder.finalize();
  if (store === null) throw new Error("Expected hydrated stroke store.");
  const originals = elements.map(({ id }) => store.get(id)!);
  return { store, originals };
}

async function scheduledDocumentFixture(maximum = false) {
  const { store, originals } = await hydratedStandardStrokes(maximum);
  const work = { reads: 0, points: 0, maxReads: 0, maxPoints: 0, totalPoints: 0, yields: 0 };
  const priorities: (string | undefined)[] = [];
  let leaseDepth = 0;
  let revision = 0;
  const shouldYield = () => work.reads >= 256 || work.points >= 256;
  const scheduler = {
    ...immediateWorkScheduler(shouldYield),
    checkpoint: (_signal?: unknown, priority?: "input" | "frame" | "background") => {
      if (!shouldYield()) return undefined;
      expect(leaseDepth).toBeGreaterThan(0);
      priorities.push(priority);
      work.yields += 1;
      work.reads = 0;
      work.points = 0;
      points.mockClear();
      return Promise.resolve();
    },
  };
  const actualPoint = strokePosition.strokeWorldPoint;
  const points = vi.spyOn(strokePosition, "strokeWorldPoint").mockImplementation((...args) => {
    work.totalPoints += 1;
    work.points += 1;
    work.maxPoints = Math.max(work.maxPoints, work.points);
    return actualPoint(...args);
  });
  const reads = vi.spyOn(store, "get").mockImplementation((id) => {
    work.reads += 1;
    work.maxReads = Math.max(work.maxReads, work.reads);
    return ElementStore.prototype.get.call(store, id);
  });
  const ranks = vi.spyOn(store, "getRank").mockImplementation((id) => {
    work.reads += 1;
    work.maxReads = Math.max(work.maxReads, work.reads);
    return ElementStore.prototype.getRank.call(store, id);
  });
  const committed = () => {
    revision += 1;
  };
  const preparationWork = {
    shouldYield,
    yieldControl: () => scheduler.checkpoint(undefined, "frame") ?? Promise.resolve(),
  };
  const model = {
    store,
    get revision() {
      return revision;
    },
    beginInteractiveOperation: () => {
      leaseDepth += 1;
      return () => {
        leaseDepth -= 1;
      };
    },
    ...elementMutationPorts(store, committed, preparationWork),
    ...elementReplacementPorts(store, committed, preparationWork),
  } as unknown as EditableDocumentModel;
  const history = new ActiveEditorHistory(model);
  const prepared = activeEditorPreparedHistory(model, history, scheduler);
  const documentHistory = new ActiveDocumentHistory({ history, model });
  return {
    store,
    originals,
    history,
    prepared,
    documentHistory,
    scheduler,
    work,
    priorities,
    inspect: (id: string) => ElementStore.prototype.get.call(store, id)!,
    cleanup: () => {
      prepared.dispose();
      documentHistory.dispose();
      history.dispose();
      points.mockRestore();
      reads.mockRestore();
      ranks.mockRestore();
      expect(leaseDepth).toBe(0);
    },
  };
}

it.each([
  { controlId: "opacity", maximum: false },
  { controlId: "stroke-width", maximum: false },
  { controlId: "stroke-width", maximum: true },
])(
  "publishes one $controlId command and reuses owned samples and bounds (maximum=$maximum)",
  async ({ controlId, maximum }) => {
    const test = await scheduledDocumentFixture(maximum);
    const publications = vi.fn();
    test.store.subscribe(publications);
    try {
      const committed = new Promise<boolean>((resolve) => {
        expect(
          test.prepared.commitStyle({
            selection: new Set(test.originals.map(({ element }) => element.id)),
            controlId,
            value: controlId === "opacity" ? 0.5 : 14,
            isCurrent: () => true,
            onCompleted: resolve,
          }),
        ).toBe(true);
      });
      expect(publications).not.toHaveBeenCalled();
      expect(await committed).toBe(true);
      expect(test.history.commandCount).toBe(1);
      expect(publications).toHaveBeenCalledOnce();
      const forward = test.originals.map(({ element }) => test.inspect(element.id));
      for (const [index, original] of test.originals.entries()) {
        if (forward[index]!.element.kind !== "stroke" || original.element.kind !== "stroke")
          throw new Error("Expected loaded strokes.");
        expect(forward[index]!.element.points).toBe(original.element.points);
        const version = controlId === "opacity" ? "paintVersion" : "geometryVersion";
        expect(forward[index]![version]).toBeGreaterThan(original[version]);
      }
      const initialPoints = test.work.totalPoints;
      expect(await test.history.undoAsync()).toBe(true);
      for (const original of test.originals) {
        const restored = test.inspect(original.element.id);
        expect(restored.element).toBe(original.element);
        expect(restored.bounds).toBe(original.bounds);
        const version = controlId === "opacity" ? "paintVersion" : "geometryVersion";
        expect(restored[version]).toBeGreaterThan(forward[0]![version]);
      }
      expect(await test.history.redoAsync()).toBe(true);
      for (const record of forward) {
        expect(test.inspect(record.element.id).element).toBe(record.element);
        expect(test.inspect(record.element.id).bounds).toBe(record.bounds);
      }
      expect(test.work.totalPoints).toBe(initialPoints);
      expect(test.store.instrumentation.bandScans).toBe(0);
      expect(test.store.instrumentation.snapshotMaterializations).toBe(0);
      expect(initialPoints).toBe(
        controlId === "opacity" ? 0 : maximum ? MAX_STROKE_POINTS : 500_000,
      );
      expect(test.work.yields).toBeGreaterThan(0);
      expect(test.work.maxReads).toBeLessThanOrEqual(257);
      expect(test.work.maxPoints).toBeLessThanOrEqual(511);
      expect(test.priorities.every((priority) => priority === "frame")).toBe(true);
      expect(publications).toHaveBeenCalledTimes(3);
    } finally {
      test.cleanup();
    }
  },
);

it.each(["bring-forward", "send-backward", "bring-to-front", "send-to-back"] as const)(
  "arranges 10,000 strokes with %s in both bands without geometry work",
  async (action) => {
    const test = await scheduledDocumentFixture();
    const publications = vi.fn();
    test.store.subscribe(publications);
    const materialize = vi.spyOn(test.store, "materializeBandOrder");
    const selection = new Set(
      test.originals.filter((_, index) => index % 4 < 2).map(({ element }) => element.id),
    );
    try {
      expect(
        await test.documentHistory.arrange(action, selection, test.scheduler, () => true),
      ).toBe("applied");
      expect(test.history.commandCount).toBe(1);
      expect(publications).toHaveBeenCalledOnce();
      expect(await test.history.undoAsync()).toBe(true);
      for (const [index, original] of test.originals.entries()) {
        expect(test.inspect(original.element.id)).toBe(original);
        expect(ElementStore.prototype.getRank.call(test.store, original.element.id)?.rank).toBe(
          Math.floor(index / 2),
        );
      }
      expect(await test.history.redoAsync()).toBe(true);
      const noopSelection =
        action === "bring-to-front" || action === "send-to-back"
          ? selection
          : new Set(test.originals.map(({ element }) => element.id));
      expect(
        await test.documentHistory.arrange(action, noopSelection, test.scheduler, () => true),
      ).toBe("noop");
      expect(test.history.commandCount).toBe(1);
      expect(publications).toHaveBeenCalledTimes(3);
      expect(test.work.totalPoints).toBe(0);
      expect(test.work.yields).toBeGreaterThan(0);
      expect(test.work.maxReads).toBeLessThanOrEqual(257);
      expect(materialize).not.toHaveBeenCalled();
      expect(test.priorities.every((priority) => priority === "frame")).toBe(true);
    } finally {
      materialize.mockRestore();
      test.cleanup();
    }
  },
);
