import { expect, it, vi } from "vitest";
import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import { ElementStore } from "../../../../../src/domain/store/public";
import { MovePreview } from "../../../../../src/obsidian/embeds/active-editor/previews/move-preview";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { SceneTransformPreviewController } from "../../../../../src/rendering/scene/presentation/transform-preview-controller";
import { ActiveEditorHandleInteraction } from "../../../../../src/obsidian/embeds/active-editor/previews/handle-interaction";
import type { SelectionPreviewOptions } from "../../../../../src/obsidian/embeds/active-editor/previews/selection-preview-contracts";
import { layoutSelectionHandles } from "../../../../../src/editor/selection/handles";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { createSynchronousActiveEditorHistory } from "../../../../fixtures/obsidian/synchronous-active-editor-history";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { createSceneFixture, sceneDeltaEntries } from "../../../../fixtures/rendering/scene";
import { connectedLine, PAGE, rectangle } from "../../../../unit/domain/store/fixtures";
import { fakeNode, FakeNode } from "../../../../unit/rendering/scene/fakes";
import { imageElement, imageResource } from "../../../../fixtures/domain/images";
import { contentPaths, paintedX } from "../../../../fixtures/rendering/selection-runs";
import { sceneBandNode } from "../../../../unit/rendering/scene/fakes";

function fixture(
  count: number,
  connected = false,
  extra: readonly InkElementV1[] = [],
  options: { readonly early?: boolean; readonly ink?: boolean } = {},
) {
  const elements: InkElementV1[] = Array.from({ length: count }, (_, i) => {
    const stroke = indexedStroke(i),
      x = 40 + (i % 100) * 10,
      y = 30 + Math.floor(i / 100) * 5;
    return options.ink
      ? {
          ...stroke,
          points: [x, y, 0.5, x + 8, y + 1, 0.5],
          pivot: { x: x + 4, y: y + 0.5 },
          style: {
            ...stroke.style,
            pressureEnabled: false,
            color: { type: "rgba" as const, value: "#000000FF" as const },
          },
        }
      : rectangle(stroke.id, x, y);
  });
  if (connected) elements.push(connectedLine(elements[0] as ReturnType<typeof rectangle>));
  elements.push(...extra);
  const store = new ElementStore(elements);
  const port = new ElementSceneStore(store);
  const resource = imageResource();
  const scene = createSceneFixture(PAGE, port, undefined, {
    imageResource: (id) => (id === resource.id ? resource : undefined),
  });
  scene.scheduler.runAll();
  const selection = new Set(elements.map(({ id }) => id));
  scene.renderer.setSelectedElements(selection);
  if (!options.early) scene.scheduler.runAll();
  const createMove = (
    overrides: Partial<
      Pick<
        SelectionPreviewOptions,
        "selection" | "selectionGeometry" | "editableSelection" | "workScheduler"
      >
    > = {},
  ) =>
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
      ...overrides,
    });
  return { ...scene, port, store, selection, createMove };
}

function pointer(x: number, y: number) {
  return { pointerId: 1, pointerType: "pen" as const, pressure: 0.5, x, y };
}

it("retains shared move and resize feedback for 10,000 editable shapes beside a locked underlay", async () => {
  const f = fixture(10_000);
  const locked = { ...rectangle("90000000-0000-4000-8000-000000000001", 0, 0), locked: true };
  const delta = f.store.create([locked]);
  f.renderer.applyDelta({ affected: sceneDeltaEntries(delta!) });
  const selection = new Set([...f.selection, locked.id]);
  const history = createSynchronousActiveEditorHistory(f.store);
  const interaction = new ActiveEditorHandleInteraction({
    frameScheduler: f.scheduler.workScheduler,
    workScheduler: immediateWorkScheduler(),
    history,
    model: {
      store: f.store,
      get revision() {
        return f.store.mutationVersion;
      },
      setGestureActive: vi.fn(),
    } as never,
    pageToScreen: (point) => point,
    preparedHistory: {} as never,
    renderer: f.renderer,
    sceneStore: f.port,
    selection: () => selection,
    zoom: () => 1,
  });
  const writes = vi.spyOn(FakeNode.prototype, "setAttribute");
  const progressive = vi.spyOn(f.renderer, "setProgressiveElementPreviews");
  try {
    interaction.renderSelection();
    f.scheduler.runAll();
    expect(fakeNode(f.renderer.svg).getAttribute("data-inkbook-run-ready")).toBe("true");
    expect(interaction.editableSelection().size).toBe(10_000);
    const move = f.createMove({
      selection: () => selection,
      selectionGeometry: () => interaction.selectionGeometry(),
      editableSelection: () => interaction.editableSelection(),
      workScheduler: immediateWorkScheduler(),
    });
    writes.mockClear();
    f.renderer.resetInstrumentation();
    move.update(pointer(15, 10));
    expect(fakeNode(f.renderer.svg).getAttribute("data-inkbook-run-feedback")).toBe("true");
    expect(writes.mock.calls.filter(([name]) => name === "transform").length).toBeLessThanOrEqual(
      2,
    );
    expect(f.renderer.instrumentation().geometryBuilds).toBe(0);
    move.revert();
    f.scheduler.runAll();
    const handle = layoutSelectionHandles(interaction.selectionGeometry(), { zoom: 1 }).find(
      (candidate) => candidate.kind === "scale" && candidate.position === "bottom-right",
    )!;
    interaction.pointerDown(pointer(handle.point.x, handle.point.y));
    await Promise.resolve();
    f.scheduler.runAll();
    await Promise.resolve();
    writes.mockClear();
    f.renderer.resetInstrumentation();
    interaction.pointerMove(pointer(handle.point.x + 30, handle.point.y + 20));
    f.scheduler.runNext();
    expect(progressive).toHaveBeenCalled();
    expect(progressive.mock.lastCall?.[3]?.selection).toBe(interaction.editableSelection());
    expect(fakeNode(f.renderer.svg).getAttribute("data-inkbook-run-feedback")).toBe("true");
    // Progressive resize may publish 256 canonical paths with two transform writes each,
    // plus the two shared selection parents; it must not transform all 10,000 members.
    expect(writes.mock.calls.filter(([name]) => name === "transform").length).toBeLessThanOrEqual(
      514,
    );
    expect(f.renderer.instrumentation().geometryBuilds).toBeLessThanOrEqual(256);
    expect(f.store.get(locked.id)?.element).toEqual(locked);
  } finally {
    writes.mockRestore();
    interaction.dispose();
    history.dispose();
    f.renderer.destroy();
    f.port.release();
  }
});

it("takes over an early move of 10,000 fixed-color strokes with an image and highlighter through three bands", () => {
  const marker: InkElementV1 = {
    ...indexedStroke(0),
    id: "00000000-0000-4000-8000-000000000011",
    tool: "highlighter",
    style: { ...indexedStroke(0).style, pressureEnabled: false },
  };
  const f = fixture(10_000, false, [imageElement(), marker], { early: true, ink: true });
  const svg = fakeNode(f.renderer.svg);
  const writes = vi.spyOn(FakeNode.prototype, "setAttribute");
  try {
    expect(svg.getAttribute("data-inkbook-run-ready")).toBeNull();
    const paths = contentPaths(svg),
      path = paths[paths.length - 1]!;
    const band = sceneBandNode(svg, "content");
    const before = paintedX(path, band);
    const preview = f.createMove();
    preview.update(pointer(10, 10));
    expect(paintedX(path, band)).toBeCloseTo(before + 10, 6);
    f.scheduler.runAll();
    expect(svg.getAttribute("data-inkbook-run-ready")).toBe("true");
    for (const delta of [20, -10, 30]) {
      writes.mockClear();
      f.renderer.resetInstrumentation();
      preview.update(pointer(delta, 10));
      expect(svg.getAttribute("data-inkbook-run-feedback")).toBe("true");
      // Only the four content/trace parents receive shared feedback transforms.
      const transforms = writes.mock.calls.flatMap(([name], index) =>
        name === "transform" ? [writes.mock.contexts[index] as FakeNode] : [],
      );
      expect(transforms.filter((node) => node.tagName === "g").length).toBeLessThanOrEqual(4);
      expect(transforms.every((node) => node.tagName === "g")).toBe(true);
      expect(paintedX(path, band)).toBeCloseTo(before + delta, 6);
      expect(f.renderer.instrumentation().geometryBuilds).toBe(0);
    }
    writes.mockClear();
    preview.revert();
    expect(paintedX(path, band)).toBeCloseTo(before, 6);
    expect(writes.mock.calls.filter(([name]) => name === "transform").length).toBeLessThanOrEqual(
      8,
    );
    f.scheduler.runAll();
    expect(svg.getAttribute("data-inkbook-run-feedback")).toBeNull();
    const repeated = f.createMove();
    repeated.update(pointer(15, 5));
    expect(svg.getAttribute("data-inkbook-run-feedback")).toBe("true");
    repeated.revert();
    expect(f.store.size).toBe(10_002);
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
