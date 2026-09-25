import { describe, expect, it, vi } from "vitest";

import { ElementStore } from "../../../../../src/domain/store/public";
import { PendingSelection } from "../../../../../src/obsidian/embeds/active-editor/pending-selection";
import { SelectionQueryWork } from "../../../../../src/obsidian/embeds/active-editor/selection-query-work";
import { ManualFrameScheduler } from "../../../../fixtures/obsidian/manual-frame-scheduler";
import { rectangle } from "../../../domain/store/fixtures";

function setup(count = 160, scheduled = true) {
  const scheduler = new ManualFrameScheduler();
  const pending = new PendingSelection();
  const store = new ElementStore();
  const state = { selection: new Set<string>() as ReadonlySet<string>, visits: 0 };
  const finished = vi.fn();
  const setSelection = vi.fn((value: ReadonlySet<string>) => {
    state.selection = value;
  });
  function* steps(): Generator<void, ReadonlySet<string>> {
    try {
      for (let index = 0; index < count; index += 1) {
        state.visits += 1;
        yield;
      }
      return new Set(["selected"]);
    } finally {
      finished();
    }
  }
  const options = {
    ...(scheduled ? { frameScheduler: scheduler } : {}),
    store,
    selection: () => state.selection,
    selectionSignal: pending.signal,
    setSelection,
  };
  const work = new SelectionQueryWork(options, steps());
  return { finished, options, pending, scheduler, setSelection, state, store, work };
}

describe("selection query scheduling", () => {
  it("bounds geometry steps per frame and publishes the completed selection only once", () => {
    const test = setup();
    expect(test.work.start()).toBe(false);
    expect(test.state.visits).toBe(64);
    expect(test.setSelection).not.toHaveBeenCalled();
    expect(test.scheduler.pendingCount).toBe(1);
    test.scheduler.runNext(1);
    expect(test.state.visits).toBe(128);
    test.scheduler.runNext(2);
    expect(test.state.visits).toBe(160);
    expect(test.setSelection).toHaveBeenCalledOnce();
    expect(test.finished).toHaveBeenCalledOnce();
    expect(test.scheduler.pendingCount).toBe(0);
    test.work.cancel();
    expect(test.finished).toHaveBeenCalledOnce();
  });

  it.each([0, 2, 1000])("yields at a simulated scheduling deadline of %s", (sliceBudgetMs) => {
    const test = setup();
    let tick = 0;
    function* measuredSteps(): Generator<void, ReadonlySet<string>> {
      for (let index = 0; index < 160; index += 1) {
        test.state.visits += 1;
        tick += 1;
        yield;
      }
      return new Set(["selected"]);
    }
    const work = new SelectionQueryWork(
      {
        ...test.options,
        selectionWorkBudget: { now: () => tick, sliceBudgetMs: () => sliceBudgetMs },
      },
      measuredSteps(),
    );
    work.start();
    const expected = Math.min(64, Math.max(1, sliceBudgetMs));
    expect(test.state.visits).toBe(expected);
    expect(test.scheduler.pendingCount).toBe(1);
    test.scheduler.runNext(1);
    expect(test.state.visits).toBe(expected * 2);
    work.cancel();
    expect(test.scheduler.pendingCount).toBe(0);
  });
});

describe("selection query work ownership", () => {
  it.each(["abort", "mutation", "selection", "revert"] as const)(
    "discards pending results after %s and releases owned work",
    (cause) => {
      const test = setup();
      test.work.start();
      if (cause === "abort") test.pending.cancel();
      if (cause === "mutation") test.store.create([rectangle()]);
      if (cause === "selection") {
        test.state.selection = new Set(["newer-selection"]);
        test.scheduler.runNext(1);
      }
      if (cause === "revert") test.work.cancel();
      expect(test.scheduler.pendingCount).toBe(0);
      expect(test.state.visits).toBe(64);
      expect(test.setSelection).not.toHaveBeenCalled();
      expect(test.finished).toHaveBeenCalledOnce();
    },
  );

  it("never starts aborted work and supplies a fresh signal for the next gesture", () => {
    const test = setup();
    test.pending.cancel();
    expect(test.work.start()).toBe(false);
    expect(test.state.visits).toBe(0);
    expect(test.scheduler.pendingCount).toBe(0);
    expect(test.pending.signal.aborted).toBe(false);
    expect(test.pending.signal).not.toBe(test.options.selectionSignal);
  });

  it("does not restart pending or completed work", () => {
    const test = setup();
    const subscribe = vi.spyOn(test.store, "subscribe");
    test.work.start();
    test.work.start();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(test.scheduler.pendingCount).toBe(1);
    expect(test.state.visits).toBe(64);
    test.work.cancel();
    test.work.start();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(test.scheduler.pendingCount).toBe(0);
  });

  it("never subscribes when cancelled before starting", () => {
    const test = setup();
    const subscribe = vi.spyOn(test.store, "subscribe");
    test.work.cancel();
    expect(test.work.start()).toBe(false);
    expect(subscribe).not.toHaveBeenCalled();
    expect(test.state.visits).toBe(0);
  });

  it("cleans up failed work without publishing a selection", () => {
    const test = setup();
    function* fail(): Generator<void, ReadonlySet<string>> {
      yield;
      throw new Error("invalid geometry");
    }
    const work = new SelectionQueryWork(test.options, fail());
    expect(() => work.start()).toThrow("invalid geometry");
    expect(test.scheduler.pendingCount).toBe(0);
    expect(test.setSelection).not.toHaveBeenCalled();
    test.store.create([rectangle()]);
  });

  it("does not republish an unchanged selection", () => {
    const test = setup();
    function* unchanged(): Generator<void, ReadonlySet<string>> {
      yield;
      return new Set();
    }
    expect(new SelectionQueryWork(test.options, unchanged()).start()).toBe(false);
    expect(test.setSelection).not.toHaveBeenCalled();
  });

  it.each([true, false])("finishes small work synchronously with scheduling=%s", (scheduled) => {
    const test = setup(2, scheduled);
    expect(test.work.start()).toBe(true);
    expect(test.state.selection).toEqual(new Set(["selected"]));
    expect(test.scheduler.pendingCount).toBe(0);
  });
});
