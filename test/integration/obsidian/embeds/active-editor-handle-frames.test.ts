import { describe, expect, it, vi } from "vitest";

import {
  buildElementPathParts,
  calculateElementBounds,
} from "../../../../src/domain/geometry/public";
import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { mutableElement } from "../../../../src/domain/store/immutability";
import { ElementStore } from "../../../../src/domain/store/public";
import {
  ActiveEditorHandleInteraction,
  type HandleInteractionRenderer,
} from "../../../../src/obsidian/embeds/active-editor/handle-interaction";
import { ActiveEditorHistory } from "../../../../src/obsidian/embeds/active-editor/history";
import type { PreparedElementHistory } from "../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import type { EditableDocumentModel } from "../../../../src/obsidian/embeds/document-model-port";
import { ManualFrameScheduler } from "../../../fixtures/obsidian/manual-frame-scheduler";
import { rectangle } from "../../../unit/domain/store/fixtures";
import { maximumStroke } from "../../../performance/editor/maximum-stroke-fixture";
import { indexedStroke } from "../../../fixtures/editor/stroke";

describe("active editor large mixed resize routing", () => {
  it("uses a single progressive candidate list for pressure and fixed-width strokes", () => {
    const elements = Array.from({ length: 513 }, (_, index) => {
      const stroke = indexedStroke(index);
      return { ...stroke, style: { ...stroke.style, pressureEnabled: index % 2 === 0 } };
    });
    const fixture = harness(elements[0]!, elements.slice(1));
    const bounds = elements.map(calculateElementBounds);
    const start = pointer(
      Math.max(...bounds.map((box) => box.maxX)),
      Math.max(...bounds.map((box) => box.maxY)),
      21,
    );
    expect(fixture.interaction.pointerDown(start)).toBe(true);
    fixture.interaction.pointerMove({ ...start, x: start.x + 100, y: start.y + 30 });
    fixture.scheduler.runNext();

    expect(fixture.renderer.setPreviewTransform.mock.lastCall?.[0]).toEqual([]);
    const [ids, materialize] = fixture.renderer.setProgressiveElementPreviews.mock.lastCall!;
    expect(ids).toEqual(elements.map(({ id }) => id));
    expect(materialize(elements[0]!.id)?.style).toEqual(elements[0]!.style);
    expect(materialize(elements[1]!.id)?.style).toEqual(elements[1]!.style);
    fixture.interaction.cancel(start.pointerId);
  });
});

describe("active editor rotated shape resize parity", () => {
  it.each(["ellipse", "rectangle"] as const)(
    "uses canonical %s geometry throughout a nonuniform group resize and commit",
    (kind) => {
      const target = { ...rectangle(), kind, rotation: 15 };
      const other = rectangle("00000000-0000-4000-8000-000000000099", 500, 350);
      const fixture = harness(target, [other]);
      const bounds = [target, other].map(calculateElementBounds);
      const start = pointer(
        Math.max(...bounds.map((box) => box.maxX)),
        Math.max(...bounds.map((box) => box.maxY)),
        20,
      );
      expect(fixture.interaction.pointerDown(start)).toBe(true);
      fixture.interaction.pointerMove({ ...start, x: start.x + 140, y: start.y + 20 });
      fixture.scheduler.runNext();
      const elements = fixture.renderer.setElementPreviews.mock.lastCall?.[0] ?? [];
      const preview = elements.find(({ id }) => id === target.id);
      expect(preview).toBeDefined();
      expect(fixture.renderer.setPreviewTransform.mock.lastCall?.[0]).toEqual([]);

      fixture.interaction.pointerUp(start.pointerId);
      const committed = fixture.store.get(target.id)?.element;
      expect(preview).toEqual(committed);
      expect(buildElementPathParts(preview!)).toEqual(
        buildElementPathParts(mutableElement(committed!)),
      );
    },
  );
});

describe("active editor handle frames", () => {
  it("queues canonical long-stroke resize snapshots and clears them when returning to the start", () => {
    const stroke = maximumStroke(0);
    const fixture = harness(stroke);
    const bounds = calculateElementBounds(stroke);
    const start = pointer(bounds.maxX, bounds.maxY, 19);
    expect(fixture.interaction.pointerDown(start)).toBe(true);
    fixture.interaction.pointerMove({ ...start, x: start.x + 100, y: start.y + 20 });
    expect(fixture.renderer.setProgressiveElementPreviews).not.toHaveBeenCalled();
    fixture.scheduler.runNext();
    const [ids, materialize, , feedback] =
      fixture.renderer.setProgressiveElementPreviews.mock.calls[0]!;
    expect(ids).toEqual([stroke.id]);
    expect(fixture.renderer.setPreviewTransform).toHaveBeenLastCalledWith(
      [],
      expect.any(String),
      expect.any(Number),
      "preserve",
      expect.any(Function),
    );
    const captured = materialize(stroke.id);
    expect(captured).not.toEqual(stroke);
    expect(captured?.style).toEqual(stroke.style);

    // Pointer feedback must keep advancing while the first canonical path is pending.
    for (let frame = 1; frame <= 12; frame += 1) {
      fixture.interaction.pointerMove({ ...start, x: start.x + 100 + frame * 5, y: start.y + 20 });
      fixture.scheduler.runNext();
      const latest = fixture.renderer.setProgressiveElementPreviews.mock.lastCall?.[3];
      expect(latest).toBeDefined();
      expect(latest?.transform).not.toEqual(feedback?.transform);
      expect(latest?.inverse).not.toEqual(feedback?.inverse);
      expect(materialize(stroke.id)).toEqual(captured);
    }

    fixture.interaction.pointerMove(start);
    fixture.scheduler.runNext();
    expect(fixture.renderer.clearProgressiveElementPreviews).toHaveBeenCalledOnce();
    expect(materialize(stroke.id)).toEqual(captured);
    fixture.interaction.cancel(start.pointerId);
    expect(fixture.renderer.clearElementPreviews).toHaveBeenCalled();
    expect(fixture.store.get(stroke.id)?.element).toEqual(stroke);
  });

  it("coalesces pointer bursts and flushes the latest sample before pointer-up commit", () => {
    const shape = rectangle();
    const fixture = harness(shape);
    const bounds = calculateElementBounds(shape);
    const start = pointer(bounds.maxX, bounds.maxY, 17);

    expect(fixture.interaction.pointerDown(start)).toBe(true);
    fixture.interaction.pointerMove({ ...start, x: 340, y: 260 });
    fixture.interaction.pointerMove({ ...start, x: 380, y: 280 }, true);
    expect(fixture.scheduler.pendingCount).toBe(1);
    expect(fixture.previewTransforms).toEqual([]);

    fixture.scheduler.runNext();
    expect(fixture.previewTransforms).toHaveLength(1);
    const scale = /scale\((?<x>[^ ]+) (?<y>[^)]+)\)/u.exec(fixture.previewTransforms[0] ?? "");
    expect(Number(scale?.groups?.x)).toBeCloseTo(Number(scale?.groups?.y), 10);

    fixture.interaction.pointerMove({ ...start, x: 420, y: 300 });
    expect(fixture.interaction.pointerUp(start.pointerId)).toBe(true);
    expect(fixture.scheduler.pendingCount).toBe(0);
    expect(fixture.scheduler.cancelledFrames).toBe(1);
    expect(fixture.previewTransforms.filter((transform) => transform !== null)).toHaveLength(2);
    const committed = fixture.store.get(shape.id)?.element;
    if (committed === undefined) throw new TypeError("Expected a committed shape.");
    const reference = harness(shape);
    reference.interaction.pointerDown(start);
    reference.interaction.pointerMove({ ...start, x: 420, y: 300 });
    reference.scheduler.runNext();
    reference.interaction.pointerUp(start.pointerId);
    expect(committed).toEqual(reference.store.get(shape.id)?.element);
    expect(calculateElementBounds(mutableElement(committed))).toMatchObject({
      minX: bounds.minX,
      minY: bounds.minY,
    });
  });

  it.each(["cancel", "dispose"] as const)("discards a pending handle sample on %s", (finish) => {
    const shape = rectangle();
    const fixture = harness(shape);
    const start = pointer(302, 202, 18);

    expect(fixture.interaction.pointerDown(start)).toBe(true);
    fixture.interaction.pointerMove({ ...start, x: 380, y: 280 });
    if (finish === "cancel") fixture.interaction.cancel(start.pointerId);
    else fixture.interaction.dispose();

    expect(fixture.scheduler.pendingCount).toBe(0);
    expect(fixture.scheduler.cancelledFrames).toBe(1);
    expect(fixture.previewTransforms.filter((transform) => transform !== null)).toEqual([]);
    expect(fixture.store.get(shape.id)?.element).toEqual(shape);
  });
});

function harness(shape: InkElementV1, others: readonly InkElementV1[] = []) {
  const elements = [shape, ...others];
  const store = new ElementStore(elements);
  const model = {
    mutationAvailability: "available",
    replaceElements: (elements: readonly InkElementV1[]) => store.replaceMany(elements),
    setGestureActive: vi.fn(),
    store,
  } as unknown as EditableDocumentModel;
  const scheduler = new ManualFrameScheduler();
  const previewTransforms: Array<string | null> = [];
  const renderer = rendererPort(previewTransforms);
  const interaction = new ActiveEditorHandleInteraction({
    frameScheduler: scheduler,
    history: new ActiveEditorHistory(model),
    model,
    pageToScreen: (point) => point,
    preparedHistory: {} as PreparedElementHistory,
    renderer,
    sceneStore: new ElementSceneStore(store),
    selection: () => new Set(elements.map(({ id }) => id)),
    zoom: () => 1,
  });
  return { interaction, previewTransforms, renderer, scheduler, store };
}

function rendererPort(previewTransforms: Array<string | null>) {
  return {
    clearElementPreviews: vi.fn(),
    clearPreviewTransforms: () => previewTransforms.push(null),
    clearProgressiveElementPreviews: vi.fn(),
    flushPointerFeedbackFrame: vi.fn(),
    setElementPreviews: vi.fn<HandleInteractionRenderer["setElementPreviews"]>(),
    setPreviewTransform: vi.fn<HandleInteractionRenderer["setPreviewTransform"]>(
      (_ids, transform) => previewTransforms.push(transform),
    ),
    setProgressiveElementPreviews:
      vi.fn<NonNullable<HandleInteractionRenderer["setProgressiveElementPreviews"]>>(),
    setSelectionOverlayPath: vi.fn(),
    setSnapMarkerPath: vi.fn(),
    suppressMotionForNextDelta: vi.fn(),
  };
}

function pointer(x: number, y: number, pointerId: number) {
  return { pointerId, pointerType: "mouse" as const, pressure: 0, x, y };
}
