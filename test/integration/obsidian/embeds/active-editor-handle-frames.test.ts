import { describe, expect, it, vi } from "vitest";

import { calculateElementBounds } from "../../../../src/domain/geometry/public";
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

describe("active editor handle frames", () => {
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

function harness(shape: ReturnType<typeof rectangle>) {
  const store = new ElementStore([shape]);
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
    selection: () => new Set([shape.id]),
    zoom: () => 1,
  });
  return { interaction, previewTransforms, scheduler, store };
}

function rendererPort(previewTransforms: Array<string | null>): HandleInteractionRenderer {
  return {
    clearElementPreviews: vi.fn(),
    clearPreviewTransforms: () => previewTransforms.push(null),
    flushPointerFeedbackFrame: vi.fn(),
    setElementPreviews: vi.fn(),
    setPreviewTransform: (_ids, transform) => previewTransforms.push(transform),
    setSelectionOverlayPath: vi.fn(),
    setSnapMarkerPath: vi.fn(),
    suppressMotionForNextDelta: vi.fn(),
  };
}

function pointer(x: number, y: number, pointerId: number) {
  return { pointerId, pointerType: "mouse" as const, pressure: 0, x, y };
}
