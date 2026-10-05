import { expect, it, vi } from "vitest";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { SceneFrameScheduler } from "../../../../src/rendering/scene/scene-frame-scheduler";
import type { SceneFrameDiagnosticSnapshot } from "../../../../src/rendering/scene/scene-frame-diagnostics";
import { FakeScheduler } from "./fakes";

function fixture() {
  const scheduler = new FakeScheduler();
  const instrumentation = createInstrumentation();
  const state = {
    pendingQuery: false,
    pendingVisibility: false,
    readyContours: 4,
    readyElements: 2,
    waitingForPaths: false,
  };
  const read = vi.fn(() => state);
  const render = vi.fn((): void => undefined);
  const frames = new SceneFrameScheduler(scheduler.workScheduler, instrumentation, render);
  const samples: SceneFrameDiagnosticSnapshot[] = [];
  const observe = vi.fn((sample: SceneFrameDiagnosticSnapshot) => samples.push(sample));
  return { scheduler, instrumentation, state, read, render, frames, samples, observe };
}

it("adds no diagnostic clock or state reads while disabled or in cursor-only frames", () => {
  const h = fixture();
  const baseline = fixture();
  const now = vi.spyOn(h.scheduler.workScheduler, "now");
  const baselineNow = vi.spyOn(baseline.scheduler.workScheduler, "now");
  const deadline = vi.spyOn(h.scheduler.workScheduler, "deadline");
  h.frames.schedule();
  h.scheduler.runNext();
  baseline.frames.schedule();
  baseline.scheduler.runNext();
  expect(deadline).not.toHaveBeenCalled();
  h.frames.observeFrames(h.observe, h.read);
  h.frames.schedule(false);
  h.scheduler.runNext();
  baseline.frames.schedule(false);
  baseline.scheduler.runNext();
  expect(h.read).not.toHaveBeenCalled();
  expect(h.observe).not.toHaveBeenCalled();
  expect(now.mock.calls.length).toBe(baselineNow.mock.calls.length);
  h.frames.dispose();
  baseline.frames.dispose();
});

it("samples the existing shared deadline and exact publication counter deltas", () => {
  const h = fixture();
  h.frames.observeFrames(h.observe, h.read);
  h.render.mockImplementation(() => {
    h.instrumentation.domRootsPublished += 3;
    h.instrumentation.domFragmentRuns += 2;
    h.instrumentation.mountBudgetYields += 1;
    h.instrumentation.mountDeadlineYields += 1;
    h.instrumentation.visibilityPathYields += 1;
    h.instrumentation.visibilityPublicationYields += 1;
    h.instrumentation.visibilityDeadlineYields += 1;
    h.scheduler.time += 9;
    Object.assign(h.state, {
      pendingQuery: true,
      pendingVisibility: true,
      readyContours: 1,
      readyElements: 0,
      waitingForPaths: true,
    });
  });
  h.frames.schedule();
  h.scheduler.runNext();
  expect(h.samples).toEqual([
    {
      ...h.state,
      frameTime: 0,
      startedAt: 0,
      deadline: 8,
      budgetMs: 8,
      remainingMsAtStart: 8,
      remainingMsAtEnd: -1,
      readyContoursAtStart: 4,
      readyElementsAtStart: 2,
      newRoots: 3,
      fragmentRuns: 2,
      mountBudgetYields: 1,
      mountDeadlineYields: 1,
      pathYields: 1,
      publicationYields: 1,
      deadlineYields: 1,
      deadlineExhausted: true,
      stopReasons: ["publication", "deadline", "paths"],
    },
  ]);
  expect(h.read).toHaveBeenCalledTimes(2);
  h.frames.dispose();
});

it("does not mistake pending worker data for an actual path interruption", () => {
  const h = fixture();
  h.state.waitingForPaths = true;
  h.state.pendingVisibility = true;
  h.frames.observeFrames(h.observe, h.read);
  h.frames.schedule();
  h.scheduler.runNext();
  expect(h.samples[0]).toMatchObject({ waitingForPaths: true, stopReasons: ["pending"] });
  h.frames.dispose();
});

it("disables a failed observer while preserving subsequent frame work", () => {
  const h = fixture();
  h.observe.mockImplementation(() => {
    throw new Error("Observer failed.");
  });
  h.frames.observeFrames(h.observe, h.read);
  for (let index = 0; index < 2; index += 1) {
    h.frames.schedule();
    expect(() => h.scheduler.runNext()).not.toThrow();
  }
  expect(h.render).toHaveBeenCalledTimes(2);
  expect(h.observe).toHaveBeenCalledOnce();
  h.frames.dispose();
});

it("reports complete and unclassified pending queues without inventing a yield", () => {
  const h = fixture();
  h.frames.observeFrames(h.observe, h.read);
  for (const pendingVisibility of [false, true]) {
    h.state.pendingVisibility = pendingVisibility;
    h.frames.schedule();
    h.scheduler.runNext();
  }
  expect(h.samples.map((sample) => sample.stopReasons)).toEqual([["complete"], ["pending"]]);
  h.frames.dispose();
});

it("unsubscribes, replaces observers, and releases a callback disposed inside its frame", () => {
  const h = fixture();
  h.frames.observeFrames(h.observe, h.read);
  h.frames.observeFrames(undefined, h.read);
  h.frames.schedule();
  h.scheduler.runNext();
  expect(h.read).not.toHaveBeenCalled();
  const replacement = vi.fn();
  h.frames.observeFrames(h.observe, h.read);
  h.frames.observeFrames(replacement, h.read);
  h.frames.schedule();
  h.scheduler.runNext();
  expect(h.observe).not.toHaveBeenCalled();
  expect(replacement).toHaveBeenCalledOnce();
  h.render.mockImplementation(() => h.frames.dispose());
  h.frames.schedule();
  h.scheduler.runNext();
  expect(replacement).toHaveBeenCalledOnce();
  h.frames.observeFrames(h.observe, h.read);
  h.frames.schedule();
  expect(h.scheduler.pendingCount).toBe(0);
});
