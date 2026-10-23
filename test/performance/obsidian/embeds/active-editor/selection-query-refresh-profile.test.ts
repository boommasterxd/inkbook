import { describe, expect, it, vi } from "vitest";

import { ElementStore } from "../../../../../src/domain/store/public";
import type { InkElementV1, PointV1 } from "../../../../../src/domain/schema/public";
import {
  createRectangleSelectionArea,
  selectBySelectionAreaCandidatesSteps,
  type SelectionAreaCandidate,
} from "../../../../../src/editor/selection/public";
import { SelectionQueryWork } from "../../../../../src/obsidian/embeds/active-editor/previews/selection-query-work";
import { LassoPreview } from "../../../../../src/obsidian/embeds/active-editor/previews/lasso-preview";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import type { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import type { PreparedElementHistory } from "../../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import * as strokeSelectionGeometry from "../../../../../src/editor/selection/query/stroke-selection-geometry";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { ManualFrameScheduler } from "../../../../fixtures/obsidian/manual-frame-scheduler";
import { createSelectionPreviewRenderer } from "../../../../fixtures/obsidian/selection-preview-renderer";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";
import { INTERACTION_REFRESH_PROFILE } from "../../../interaction-refresh-profile";

const profile = INTERACTION_REFRESH_PROFILE;
const targets = Array.from({ length: 10_000 }, (_, index) => indexedStroke(index));

describe(`${profile.refreshRate} Hz selection-query scheduling`, () => {
  it.for(["deadline", "in-budget", "over-budget"] as const)(
    "tracks actual selection iterator work under %s scheduling",
    (checkpoint) => {
      const store = new ElementStore(targets);
      const scheduler = new ManualFrameScheduler();
      const controller = new AbortController();
      const selection = new Set<string>();
      const publish = vi.fn();
      const closed = vi.fn();
      const read = vi.spyOn(store, "get");
      function* candidates(): Generator<SelectionAreaCandidate, boolean> {
        try {
          for (const target of targets) {
            const record = store.get(target.id)!;
            yield { id: target.id, bounds: record.bounds, element: target };
          }
          return true;
        } finally {
          closed();
        }
      }
      const steps = selectBySelectionAreaCandidatesSteps(
        selection,
        createRectangleSelectionArea({ x: 0, y: 0 }, { x: 2000, y: 2000 }),
        "fully-enclosed",
        false,
        candidates(),
      );
      const next = steps.next.bind(steps);
      let simulatedNow = 0;
      // Inject scheduling checkpoints only; these ticks do not measure execution speed.
      const increment = checkpoint === "deadline" ? 1 : checkpoint === "in-budget" ? 0 : 100;
      const advance = vi.spyOn(steps, "next").mockImplementation(() => {
        const result = next();
        simulatedNow += increment;
        return result;
      });
      let sliceStart = 0;
      const work = new SelectionQueryWork(
        {
          workScheduler: workSchedulerFromFrames(scheduler, {
            shouldYield: () => simulatedNow - sliceStart >= profile.interruptibleSliceDeadlineMs,
          }),
          selection: () => selection,
          selectionSignal: controller.signal,
          setSelection: publish,
          store,
        },
        steps,
      );
      const expected =
        checkpoint === "deadline" ? Math.ceil(profile.interruptibleSliceDeadlineMs) : 1;
      work.start();
      if (checkpoint === "in-budget") {
        expect(read).toHaveBeenCalledTimes(targets.length);
        expect(advance.mock.calls.length).toBeGreaterThan(4096);
        expect(scheduler.pendingCount).toBe(0);
        expect(closed).toHaveBeenCalledOnce();
        expect(publish).toHaveBeenCalledOnce();
        return;
      }
      expect(advance).toHaveBeenCalledTimes(expected);
      expect(scheduler.pendingCount).toBe(1);
      sliceStart = simulatedNow;
      scheduler.runNext(profile.frameDurationMs);
      expect(advance).toHaveBeenCalledTimes(expected * 2);
      expect(read.mock.calls.length).toBeGreaterThan(0);
      expect(read.mock.calls.length).toBeLessThanOrEqual(expected * 2);
      controller.abort();
      expect(scheduler.pendingCount).toBe(0);
      expect(closed).toHaveBeenCalledOnce();
      expect(publish).not.toHaveBeenCalled();
      expect(advance).toHaveBeenCalledTimes(expected * 2);
    },
  );
});

describe(`${profile.refreshRate} Hz contained selection completion`, () => {
  it.for(["rectangle", "lasso"] as const)(
    "completes 10,000 pressure strokes in bounded %s slices without rebuilding geometry",
    (area) => {
      let reads = 0;
      let readsBefore = 0;
      const test = containedSelection(area, targets, undefined, () => reads - readsBefore >= 4096);
      const get = test.store.get.bind(test.store);
      const read = vi.spyOn(test.store, "get").mockImplementation((id) => {
        reads += 1;
        return get(id);
      });
      const primitives = vi.spyOn(strokeSelectionGeometry, "strokePrimitiveSteps");
      const begin = test.sceneStore.beginQuery.bind(test.sceneStore);
      const query = begin({ minX: 0, minY: 0, maxX: 2000, maxY: 2000 });
      const advance = vi.spyOn(query, "advance");
      vi.spyOn(test.sceneStore, "beginQuery").mockReturnValue(query);
      try {
        expect(test.preview.commit()).toBe(false);
        let slices = 1;
        while (test.scheduler.pendingCount > 0 && slices <= (area === "lasso" ? 16 : 10)) {
          expect(read.mock.calls.length - readsBefore).toBeLessThanOrEqual(4096);
          expect(test.publish).not.toHaveBeenCalled();
          readsBefore = read.mock.calls.length;
          test.scheduler.runNext(slices * profile.frameDurationMs);
          slices += 1;
        }
        expect(slices).toBeLessThanOrEqual(area === "lasso" ? 16 : 10);
        expect(test.scheduler.pendingCount).toBe(0);
        expect(read.mock.calls.length - readsBefore).toBeLessThanOrEqual(4096);
        expect(read).toHaveBeenCalledTimes(targets.length);
        expect(test.publish).toHaveBeenCalledExactlyOnceWith(new Set(targets.map(({ id }) => id)));
        expect(primitives).not.toHaveBeenCalled();
        const visits = advance.mock.results.map((result) =>
          result.type === "return" ? result.value.workUnits : Infinity,
        );
        expect(Math.max(...visits)).toBeLessThanOrEqual(64);
        // 10,000 slots plus bounded cell/column traversal in the 100-by-100 grid.
        expect(visits.reduce((total, value) => total + value, 0)).toBeLessThanOrEqual(12_000);
        expect(test.store.instrumentation.fullStoreScans).toBe(0);
      } finally {
        primitives.mockRestore();
        test.preview.revert();
        test.sceneStore.release();
      }
    },
  );
});

function containedSelection(
  area: "rectangle" | "lasso",
  elements: readonly InkElementV1[],
  outline?: readonly PointV1[],
  shouldYield?: () => boolean,
) {
  const store = new ElementStore(elements);
  const sceneStore = new ElementSceneStore(store);
  const scheduler = new ManualFrameScheduler();
  const publish = vi.fn();
  const selection = new Set<string>();
  const pointer = { pointerId: 1, pointerType: "mouse" as const, pressure: 0.5, x: 0, y: 0 };
  const preview = new LassoPreview({
    history: {} as ActiveEditorHistory,
    preparedHistory: {} as PreparedElementHistory,
    renderer: createSelectionPreviewRenderer(),
    pageToScreen: (point) => point,
    frameScheduler: scheduler,
    workScheduler: workSchedulerFromFrames(scheduler, {
      shouldYield: shouldYield ?? (() => false),
    }),
    selection: () => selection,
    selectionDefaults: { area, inclusion: outline === undefined ? "fully-enclosed" : "touched" },
    setSelection: publish,
    start: { additive: false, kind: "lasso", pointer, tool: "select" },
    store,
    sceneStore,
  });
  if (outline !== undefined) {
    for (const point of outline) preview.update({ ...pointer, ...point });
  } else {
    if (area === "lasso") preview.update({ ...pointer, x: 2000 });
    preview.update({ ...pointer, x: 2000, y: 2000 });
    if (area === "lasso") preview.update({ ...pointer, y: 2000 });
  }
  store.resetInstrumentation();
  return { preview, store, sceneStore, scheduler, publish };
}

// The lasso's AABB includes these strokes, but its even-odd filled region does not.
it("rejects 10,000 strokes inside a concave lasso notch without reading stroke geometry", () => {
  const elements = targets.map((element) => ({ ...element, points: [40, 40, 0.5, 60, 60, 0.5] }));
  const test = containedSelection("lasso", elements, [
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 70, y: 100 },
    { x: 70, y: 20 },
    { x: 30, y: 20 },
    { x: 30, y: 100 },
    { x: 0, y: 100 },
  ]);
  const primitives = vi.spyOn(strokeSelectionGeometry, "strokePrimitiveSteps");
  const read = vi.spyOn(test.store, "get");
  try {
    test.preview.commit();
    let slices = 1;
    // Each frame is capped at 4096 charged units. A <=32-visit stroke-box
    // predicate checkpoint costs one unit; raw edge visits are bounded separately.
    while (test.scheduler.pendingCount > 0 && slices <= 16) {
      test.scheduler.runNext(slices++ * profile.frameDurationMs);
    }
    expect(test.scheduler.pendingCount).toBe(0);
    expect(read).toHaveBeenCalledTimes(elements.length);
    expect(primitives).not.toHaveBeenCalled();
    expect(test.publish).not.toHaveBeenCalled();
  } finally {
    primitives.mockRestore();
    test.preview.revert();
    test.sceneStore.release();
  }
});

it("charges individual rectangle primitives below a whole geometry batch", () => {
  const elements = targets.slice(0, 32).map((element) => ({
    ...element,
    points: Array.from({ length: 250 }, (_, index) => [
      Math.round(40_000 + (index * 20_000) / 249) / 1000,
      Math.round(50_000 + 8_000 * Math.sin(index * 0.16)) / 1000,
      0.5,
    ]).flat(),
  }));
  const store = new ElementStore(elements);
  const scheduler = new ManualFrameScheduler();
  const selection = new Set<string>();
  const publish = vi.fn();
  let candidatesRead = 0;
  function* candidates(): Generator<SelectionAreaCandidate, boolean> {
    for (const element of elements) {
      const record = store.get(element.id)!;
      candidatesRead += 1;
      yield { id: element.id, bounds: record.bounds, element: record.element as InkElementV1 };
    }
    return true;
  }
  const work = new SelectionQueryWork(
    {
      workScheduler: workSchedulerFromFrames(scheduler),
      selection: () => selection,
      setSelection: publish,
      store,
    },
    selectBySelectionAreaCandidatesSteps(
      selection,
      createRectangleSelectionArea({ x: 50, y: 45 }, { x: 55, y: 55 }),
      "touched",
      false,
      candidates(),
    ),
  );
  const primitives = vi.spyOn(strokeSelectionGeometry, "strokePrimitiveSteps");
  try {
    work.start();
    if (scheduler.pendingCount > 0) scheduler.runNext(profile.frameDurationMs);
    expect(scheduler.pendingCount).toBe(0);
    expect(candidatesRead).toBe(32);
    expect(primitives).toHaveBeenCalledTimes(32);
    expect(publish).toHaveBeenCalledExactlyOnceWith(new Set(elements.map(({ id }) => id)));
  } finally {
    primitives.mockRestore();
    work.cancel();
  }
});
