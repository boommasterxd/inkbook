import { createSelectionPreviewRenderer } from "../../../../fixtures/obsidian/selection-preview-renderer";
import { describe, expect, it, vi } from "vitest";

import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import { ManualFrameScheduler } from "../../../../fixtures/obsidian/manual-frame-scheduler";
import { stroke } from "../../../domain/schema/fixtures";
import { rectangle } from "../../../domain/store/fixtures";
import { ElementStore } from "../../../../../src/domain/store/public";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import type { PreparedElementHistory } from "../../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { LassoPreview } from "../../../../../src/obsidian/embeds/active-editor/selection-preview";

it("projects only appended lasso points and rebuilds after camera changes or compaction", () => {
  const store = new ElementStore([]);
  const sceneStore = new ElementSceneStore(store);
  const paths: string[] = [];
  const renderer = {
    ...createSelectionPreviewRenderer(),
    setOverlayPath: (path: string | null) => {
      if (path !== null) paths.push(path);
    },
  };
  let offset = 0;
  const project = vi.fn((point: { x: number; y: number }) => ({
    x: point.x + offset,
    y: point.y,
  }));
  const preview = new LassoPreview({
    history: {} as ActiveEditorHistory,
    pageToScreen: project,
    preparedHistory: {} as PreparedElementHistory,
    renderer,
    sceneStore,
    selection: () => new Set<string>(),
    selectionDefaults: { area: "lasso", inclusion: "touched" },
    setSelection: () => {},
    start: { additive: false, kind: "lasso", pointer: pointer(0, 0), tool: "select" },
    store,
  });
  project.mockClear();
  for (let index = 1; index <= 511; index += 1) preview.update(pointer(index * 2, 0));
  expect(project).toHaveBeenCalledTimes(511 * 4);
  const priorPath = paths[paths.length - 1];
  preview.update(pointer(1022, 0));
  expect(project).toHaveBeenCalledTimes(511 * 4 + 3);
  expect(paths[paths.length - 1]).toBe(priorPath);
  offset = 5;
  preview.update(pointer(1022, 0));
  expect(project).toHaveBeenCalledTimes(511 * 4 + 3 + 3 + 512);
  expect(paths[paths.length - 1]).toContain("M 5 0");
  const beforeCompaction = project.mock.calls.length;
  preview.update(pointer(1024, 0));
  expect(project.mock.calls.length - beforeCompaction).toBeGreaterThan(3);
  sceneStore.release();
});

describe("lasso preview regressions", () => {
  it.each([
    { additive: false, changed: true, expected: new Set<string>() },
    { additive: true, changed: false, expected: new Set(["selected-before-gesture"]) },
  ])("handles a degenerate lasso with additive=$additive", ({ additive, changed, expected }) => {
    const { preview, sceneStore, state } = createPreview(additive);
    preview.update(pointer(20, 0));

    expect(preview.commit()).toBe(changed);
    expect(state.selection).toEqual(expected);
    sceneStore.release();
  });

  it.each(["complete", "mutation", "new-gesture"] as const)(
    "handles %s during a real pressure-stroke selection query",
    (outcome) => {
      const source = stroke();
      const target = {
        ...source,
        points: Array.from({ length: 2048 }, (_, index) => [
          index,
          Math.round(Math.sin(index / 9) * 10_000) / 1000,
          Math.round(500 + Math.sin(index / 13) * 400) / 1000,
        ]).flat(),
      };
      const test = createPreview(true, [target]);
      // The notch crosses the bounds but misses the ink, requiring complete contour checks.
      for (const [x, y] of [
        [2100, -30],
        [2100, 30],
        [-10, 30],
        [-10, -8],
        [1, -8],
        [1, -30],
        [-10, -30],
      ]) {
        test.preview.update(pointer(x!, y!));
      }
      expect(test.preview.commit()).toBe(false);
      expect(test.scheduler.pendingCount).toBe(1);
      expect(test.state.selection).toEqual(new Set(["selected-before-gesture"]));
      if (outcome === "mutation") test.store.create([rectangle()]);
      if (outcome === "new-gesture") test.controller.abort();
      if (outcome === "complete") {
        for (let frame = 0; test.scheduler.pendingCount > 0 && frame < 5000; frame += 1) {
          test.scheduler.runNext(frame);
        }
      }
      expect(test.scheduler.pendingCount).toBe(0);
      expect(test.state.selection).toEqual(
        new Set(
          outcome === "complete"
            ? ["selected-before-gesture", target.id]
            : ["selected-before-gesture"],
        ),
      );
      test.sceneStore.release();
    },
  );
});

describe("bounded lasso spatial queries", () => {
  it.each(["abort", "stale"] as const)(
    "discards an incomplete 10,000-stroke query on %s",
    (outcome) => {
      const targets = Array.from({ length: 10_000 }, (_, index) => ({
        ...stroke(index + 1),
        points: [index % 100, Math.floor(index / 100), 0.5],
      }));
      const test = createPreview(true, targets);
      const begin = test.sceneStore.beginQuery.bind(test.sceneStore);
      const query = begin({ minX: -10, minY: -30, maxX: 200, maxY: 200 });
      const advance = vi.spyOn(query, "advance");
      const cancel = vi.spyOn(query, "cancel");
      vi.spyOn(test.sceneStore, "beginQuery").mockReturnValue(query);
      const read = vi.spyOn(test.store, "get");
      for (const [x, y] of [
        [200, -30],
        [200, 200],
        [-10, 200],
        [-10, -30],
      ]) {
        test.preview.update(pointer(x!, y!));
      }
      expect(test.preview.commit()).toBe(false);
      expect(advance).toHaveBeenCalledWith(64);
      for (const result of advance.mock.results) {
        if (result.type === "return") expect(result.value.workUnits).toBeLessThanOrEqual(64);
      }
      expect(read.mock.calls.length).toBeGreaterThan(0);
      expect(read.mock.calls.length).toBeLessThanOrEqual(4096);
      if (outcome === "abort") test.controller.abort();
      else {
        advance.mockReturnValue({ ids: [], workUnits: 0, done: true, stale: true });
        for (let frame = 0; test.scheduler.pendingCount > 0 && frame < 100; frame += 1) {
          test.scheduler.runNext(frame);
        }
      }
      expect(test.scheduler.pendingCount).toBe(0);
      expect(cancel).toHaveBeenCalledOnce();
      expect(read.mock.calls.length).toBeLessThan(10_000);
      expect(test.state.selection).toEqual(new Set(["selected-before-gesture"]));
      test.sceneStore.release();
    },
  );
});

function pointer(x: number, y: number) {
  return { pointerId: 10, pointerType: "mouse" as const, pressure: 0.5, x, y };
}

function createPreview(additive: boolean, targets: readonly InkElementV1[] = []) {
  const store = new ElementStore(targets);
  const sceneStore = new ElementSceneStore(store);
  const scheduler = new ManualFrameScheduler();
  const controller = new AbortController();
  const state = { selection: new Set(["selected-before-gesture"]) as ReadonlySet<string> };
  const preview = new LassoPreview({
    history: {} as ActiveEditorHistory,
    pageToScreen: (point) => point,
    preparedHistory: {} as PreparedElementHistory,
    renderer: createSelectionPreviewRenderer(),
    frameScheduler: scheduler,
    sceneStore,
    selection: () => state.selection,
    selectionSignal: controller.signal,
    selectionDefaults: { area: "lasso", inclusion: "fully-enclosed" },
    setSelection: (next) => {
      state.selection = next;
    },
    start: {
      additive,
      kind: "lasso",
      pointer: targets.length === 0 ? pointer(0, 0) : pointer(-10, -30),
      tool: "select",
    },
    store,
  });
  return { controller, preview, sceneStore, scheduler, state, store };
}
