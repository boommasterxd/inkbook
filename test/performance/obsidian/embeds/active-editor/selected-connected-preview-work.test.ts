import { afterEach, expect, it, vi } from "vitest";

import * as overlay from "../../../../../src/editor/selection/overlay-geometry";
import * as paths from "../../../../../src/domain/geometry/element-path";
import { ElementStore } from "../../../../../src/domain/store/public";
import { SelectionFrameSession } from "../../../../../src/editor/selection/public";
import { layoutSelectionHandles } from "../../../../../src/editor/selection/handles";
import { SelectionScaleGesture } from "../../../../../src/editor/selection/transform/selection-scale";
import { ActiveEditorHandleInteraction } from "../../../../../src/obsidian/embeds/active-editor/previews/handle-interaction";
import { MovePreview } from "../../../../../src/obsidian/embeds/active-editor/previews/move-preview";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { SceneContentRenderer } from "../../../../../src/rendering/scene/content-renderer";
import { createSceneFixture } from "../../../../fixtures/rendering/scene";
import { createWorkerSnapshot } from "../../../../fixtures/persistence/worker-snapshot";
import { createStandardDomainFixture } from "../../../domain/standard-domain-fixture";
import { INTERACTION_REFRESH_PROFILE as profile } from "../../../interaction-refresh-profile";
import { expectReleasedPreviewScene } from "../../../../fixtures/rendering/connected-preview-work";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const input = createStandardDomainFixture();
  const store = new ElementStore(input.elements);
  const sceneStore = new ElementSceneStore(store);
  const selected = input.elements.filter(
    (element) => element.kind === "line" || element.kind === "arrow",
  );
  const selection = new Set(selected.map(({ id }) => id));
  const focus = store.get(selected[400]!.id)!.bounds;
  const viewport = { left: 0, top: focus.minY - 10, width: 2048, height: 200 };
  const scene = createSceneFixture(createWorkerSnapshot([]).page, sceneStore, viewport, {
    frameBudgetMs: profile.interruptibleSliceDeadlineMs,
  });
  scene.renderer.setReducedMotion(true);
  scene.renderer.setSelectedElements(selection);
  scene.scheduler.runAll(2_000);
  return { ...scene, store, sceneStore, selected, selection, viewport };
}

type Fixture = ReturnType<typeof fixture>;
const pointer = (x: number, y: number) => ({ x, y, pointerId: 1, pointerType: "mouse" as const });

function gesture(test: Fixture, kind: "move" | "resize") {
  const common = {
    frameScheduler: test.scheduler.workScheduler,
    workScheduler: test.scheduler.workScheduler,
    history: {} as never,
    preparedHistory: {} as never,
    renderer: test.renderer,
    sceneStore: test.sceneStore,
    selection: () => test.selection,
    pageToScreen: (point: { x: number; y: number }) => point,
  };
  if (kind === "move") {
    const move = new MovePreview({
      ...common,
      store: test.store,
      connectionSnapping: false,
      setSelection: () => undefined,
      start: { kind: "element-move", tool: "select", additive: false, pointer: pointer(0, 0) },
    });
    return {
      update: (delta: number) => move.update(pointer(delta, delta)),
      cancel: () => move.revert(),
      dispose: () => move.revert(),
    };
  }
  const frames = new SelectionFrameSession();
  const interaction = new ActiveEditorHandleInteraction({
    ...common,
    model: { store: test.store, revision: 0, setGestureActive: () => undefined } as never,
    selectionFrames: frames,
    zoom: () => 1,
  });
  const selected = interaction.selectionGeometry();
  const frame = frames.current(selected);
  const handle = layoutSelectionHandles(selected, { frame, zoom: 1 }).find(
    (item) => item.kind === "scale" && item.position === "bottom-right",
  )!;
  expect(interaction.pointerDown(pointer(handle.point.x, handle.point.y))).toBe(true);
  return {
    update: (delta: number) =>
      interaction.pointerMove(pointer(handle.point.x + delta, handle.point.y + delta)),
    cancel: () => interaction.cancel(),
    dispose: () => interaction.dispose(),
  };
}

function observeWork(test: Fixture) {
  let work = 0;
  const charge = () => {
    work += 1;
    test.scheduler.time += 1;
  };
  const originalPoint = overlay.transformSelectionPoint;
  const point = vi.spyOn(overlay, "transformSelectionPoint").mockImplementation((...args) => {
    charge();
    return originalPoint(...args);
  });
  const originalScale = Object.getOwnPropertyDescriptor(
    SelectionScaleGesture.prototype,
    "materializeOne",
  )!.value as SelectionScaleGesture["materializeOne"];
  const scale = vi
    .spyOn(SelectionScaleGesture.prototype, "materializeOne")
    .mockImplementation(function (
      this: SelectionScaleGesture,
      ...args: Parameters<SelectionScaleGesture["materializeOne"]>
    ) {
      charge();
      return originalScale.apply(this, args);
    });
  const originalPath = paths.buildElementPathParts;
  const geometry = vi.spyOn(paths, "buildElementPathParts").mockImplementation((...args) => {
    charge();
    return originalPath(...args);
  });
  const applied = vi.spyOn(SceneContentRenderer.prototype, "applyCanonicalElementPreview");
  return { point, scale, geometry, applied, work: () => work };
}

function drain(test: Fixture, observed: ReturnType<typeof observeWork>) {
  let frames = 0;
  while (test.scheduler.pendingCount > 0) {
    expect(frames++).toBeLessThan(2_000);
    const before = observed.work();
    test.scheduler.time += profile.frameDurationMs;
    test.scheduler.runNext();
    // One admitted linear unit may finish two endpoint transforms and one path after the deadline.
    expect(observed.work() - before).toBeLessThanOrEqual(
      Math.ceil(profile.interruptibleSliceDeadlineMs) + 3,
    );
  }
}

it.each(["move", "resize"] as const)(
  "bounds selected connected %s previews to mounted roots in a 10,000-stroke document",
  async (kind) => {
    const test = fixture();
    const active = gesture(test, kind);
    await Promise.resolve();
    const observed = observeWork(test);
    try {
      const visible = new Set(
        test.renderer.mountedIds("content").filter((id) => test.selection.has(id)),
      );
      expect(visible.size).toBeGreaterThan(0);
      expect(visible.size).toBeLessThan(test.selection.size);
      for (const delta of [30, 50, 20]) {
        observed.applied.mockClear();
        active.update(delta);
        drain(test, observed);
        const published = new Set(observed.applied.mock.calls.map(([element]) => element.id));
        expect(published).toEqual(visible);
      }
      const unseen = test.selected.find(({ id }) => !visible.has(id))!;
      const bounds = test.store.get(unseen.id)!.bounds;
      test.renderer.setViewport({ ...test.viewport, top: bounds.minY - 10 });
      observed.applied.mockClear();
      drain(test, observed);
      expect(observed.applied.mock.calls.some(([element]) => element.id === unseen.id)).toBe(true);
      expect(test.store.mutationVersion).toBe(0);
      expect(observed.geometry).toHaveBeenCalled();
      expect(
        kind === "move" ? observed.point.mock.calls.length : observed.scale.mock.calls.length,
      ).toBeGreaterThan(0);
      active.cancel();
      drain(test, observed);
    } finally {
      active.dispose();
      test.renderer.destroy();
      test.sceneStore.release();
      test.store.releasePreparedPressureGeometry();
    }
    expectReleasedPreviewScene(test.renderer, test.scheduler);
  },
);
