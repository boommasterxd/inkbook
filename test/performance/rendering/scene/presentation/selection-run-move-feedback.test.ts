import { expect, it, vi } from "vitest";
import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import { ElementStore } from "../../../../../src/domain/store/public";
import { MovePreview } from "../../../../../src/obsidian/embeds/active-editor/previews/move-preview";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { SceneTransformPreviewController } from "../../../../../src/rendering/scene/presentation/transform-preview-controller";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { createSynchronousActiveEditorHistory } from "../../../../fixtures/obsidian/synchronous-active-editor-history";
import { createSceneFixture } from "../../../../fixtures/rendering/scene";
import { connectedLine, PAGE, rectangle } from "../../../../unit/domain/store/fixtures";
import { fakeNode, FakeNode } from "../../../../unit/rendering/scene/fakes";

function fixture(count: number, connected = false) {
  const elements: InkElementV1[] = Array.from({ length: count }, (_, i) =>
    rectangle(indexedStroke(i).id, 40 + (i % 100) * 10, 30 + Math.floor(i / 100) * 5),
  );
  if (connected) elements.push(connectedLine(elements[0] as ReturnType<typeof rectangle>));
  const store = new ElementStore(elements);
  const port = new ElementSceneStore(store);
  const scene = createSceneFixture(PAGE, port);
  scene.scheduler.runAll();
  const selection = new Set(elements.map(({ id }) => id));
  scene.renderer.setSelectedElements(selection);
  scene.scheduler.runAll();
  const createMove = () =>
    new MovePreview({
      history: createSynchronousActiveEditorHistory(store),
      preparedHistory: { commitMove: () => false } as never,
      renderer: scene.renderer,
      sceneStore: port,
      selection: () => selection,
      setSelection: vi.fn(),
      pageToScreen: (point) => point,
      start: {
        additive: false,
        kind: "element-move",
        tool: "select",
        pointer: pointer(0, 0),
      },
      store,
    });
  return { ...scene, port, store, selection, createMove };
}

function pointer(x: number, y: number) {
  return { pointerId: 1, pointerType: "pen" as const, pressure: 0.5, x, y };
}

it("moves 10,000 mounted selected shapes with bounded actual DOM feedback writes and cancels cleanly", () => {
  const f = fixture(10_000);
  const svg = fakeNode(f.renderer.svg);
  const writes = vi.spyOn(FakeNode.prototype, "setAttribute");
  try {
    expect(svg.getAttribute("data-inkbook-run-ready")).toBe("true");
    const preview = f.createMove();
    for (const delta of [10, 20, -10]) {
      writes.mockClear();
      f.renderer.resetInstrumentation();
      preview.update(pointer(delta, 10));
      expect(svg.getAttribute("data-inkbook-run-feedback")).toBe("true");
      // Translation keeps prepared local bases unchanged and writes only shared parents.
      const transforms = writes.mock.calls.filter(([name]) => name === "transform");
      expect(transforms.length).toBeLessThanOrEqual(2);
      expect(transforms.some(([, value]) => value === `translate(${delta} 10)`)).toBe(true);
      expect(f.renderer.instrumentation().geometryBuilds).toBe(0);
    }
    writes.mockClear();
    preview.revert();
    expect(svg.getAttribute("data-inkbook-run-feedback")).toBeNull();
    expect(writes.mock.calls.filter(([name]) => name === "transform").length).toBeLessThanOrEqual(
      2,
    );
    const repeated = f.createMove();
    repeated.update(pointer(15, 5));
    expect(svg.getAttribute("data-inkbook-run-feedback")).toBe("true");
    repeated.revert();
    expect(f.store.size).toBe(10_000);
  } finally {
    writes.mockRestore();
    f.renderer.destroy();
    f.port.release();
  }
});

it("keeps selected connected line subsets on their existing element and transform owners", () => {
  const f = fixture(600, true);
  try {
    expect(fakeNode(f.renderer.svg).getAttribute("data-inkbook-run-ready")).toBe("true");
    const forward = vi.spyOn(f.renderer, "setPreviewTransform");
    const preview = f.createMove();
    preview.update(pointer(15, 10));
    const request = forward.mock.calls[forward.mock.calls.length - 1]!;
    expect(request[0]).toHaveLength(600);
    expect(Array.isArray(request[5])).toBe(true);
    expect(fakeNode(f.renderer.svg).getAttribute("data-inkbook-run-feedback")).toBeNull();
    preview.revert();
  } finally {
    f.renderer.destroy();
    f.port.release();
  }
});

it("keeps ready shared feedback and context changes out of the per-member transform map", () => {
  const ids = Array.from({ length: 10_000 }, (_, i) => String(i));
  const selection = new Set(ids);
  const feedback = {
    selection,
    selectionSize: ids.length,
    matrix: [1, 0, 0, 1, 5, 2] as const,
    transform: "translate(5 2)",
    inverse: "translate(-5 -2)",
    invertible: true,
  };
  const apply = vi.fn();
  const mounted = vi.fn(() => ids);
  const clear = vi.fn();
  const controller = new SceneTransformPreviewController(
    {
      applyPreviewTransform: apply,
      flushSelectionContext: vi.fn(),
      promoteVisible: vi.fn(),
      previewMountedIds: mounted,
      canUseSelectionFeedback: () => true,
      selectionFeedbackIds: () => ids,
      selectionFeedbackExceptionIds: () => [ids[0]!],
      publishSelectionFeedback: () => true,
      clearSelectionFeedback: clear,
      refreshSelectionFeedbackZoom: vi.fn(),
    },
    { x: 0, zoom: 1 },
  );
  controller.set(ids, feedback.transform, 1, "scale", undefined, feedback);
  controller.write();
  controller.setContext({ x: 5, zoom: 2 }, undefined);
  controller.refreshContext();
  controller.write();
  expect(controller.values.size).toBe(0);
  expect(mounted).not.toHaveBeenCalled();
  expect(apply).toHaveBeenCalledTimes(1);
  controller.clear();
  expect(clear).toHaveBeenCalledOnce();
  controller.write();
  expect(apply).toHaveBeenCalledTimes(2);
  expect(apply).toHaveBeenLastCalledWith(ids[0], null, Number.MAX_SAFE_INTEGER, null);
  expect(controller.memoryUsage()).toBe(0);
});

it("clears borrowed local exceptions before handing shared feedback back to the legacy writer", () => {
  const ids = ["grouped", "exception"];
  const selection = new Set(ids);
  const feedback = {
    selection,
    selectionSize: 2,
    matrix: [1, 0, 0, 1, 5, 2] as const,
    transform: "translate(5 2)",
    inverse: "translate(-5 -2)",
    invertible: true,
  };
  const apply = vi.fn();
  const controller = new SceneTransformPreviewController(
    {
      applyPreviewTransform: apply,
      flushSelectionContext: vi.fn(),
      promoteVisible: vi.fn(),
      previewMountedIds: () => ids,
      canUseSelectionFeedback: (candidate) => candidate === feedback,
      selectionFeedbackIds: () => ids,
      selectionFeedbackExceptionIds: () => ["exception"],
      publishSelectionFeedback: () => true,
      clearSelectionFeedback: vi.fn(),
    },
    { x: 0, zoom: 1 },
  );
  controller.set(ids, feedback.transform, 1, "scale", undefined, feedback);
  controller.write();
  apply.mockClear();
  controller.set(["grouped"], "translate(7 0)", 2, "scale");
  controller.write();
  expect(apply.mock.calls).toEqual([
    ["exception", null, Number.MAX_SAFE_INTEGER, null],
    ["grouped", "translate(7 0)", 2, null],
  ]);
  controller.clear();
  controller.write();
  expect(controller.values.size).toBe(0);
  expect(controller.memoryUsage()).toBe(0);
});
