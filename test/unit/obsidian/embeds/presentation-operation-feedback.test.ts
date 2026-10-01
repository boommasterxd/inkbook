import { describe, expect, it, vi } from "vitest";

import {
  PRESENTATION_LOADING_FEEDBACK_DELAY_MS,
  PRESENTATION_SAVING_FEEDBACK_DELAY_MS,
  PresentationOperationFeedback,
} from "../../../../src/obsidian/embeds/presentation-operation-feedback";
import { FakePresentationElement } from "../../../fixtures/obsidian/presentation-dom";
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";

describe("PresentationOperationFeedback held insertion", () => {
  it("reserves loading space only when delayed loading feedback is actually painted", () => {
    const reserve = vi.fn();
    const harness = createHarness(reserve);
    harness.feedback.begin("loading").finish();
    harness.runTimer();
    expect(reserve).not.toHaveBeenCalled();
    harness.feedback.begin("saving");
    harness.runTimer();
    expect(reserve).not.toHaveBeenCalled();
    const cancelled = harness.feedback.begin("loading");
    harness.runTimer();
    cancelled.finish();
    harness.runFrame();
    expect(reserve).not.toHaveBeenCalled();
    harness.feedback.begin("loading");
    harness.runTimer();
    expect(reserve).not.toHaveBeenCalled();
    harness.runFrame();
    expect(reserve).toHaveBeenCalledOnce();
    expect(harness.indicator()?.dataset.inkbookOperation).toBe("loading");
    harness.feedback.dispose();
  });
});

describe("PresentationOperationFeedback layout", () => {
  it.each(["loading", "saving"] as const)(
    "measures %s feedback before inserting its live DOM indicator",
    (kind) => {
      const harness = createHarness();
      const read = vi.spyOn(harness.root, "getBoundingClientRect").mockImplementation(() => {
        expect(harness.indicator()).toBeNull();
        return { bottom: 100, height: 100, left: 0, right: 600, top: 0, width: 600 };
      });
      harness.feedback.begin(kind);
      harness.runTimer();
      if (kind === "loading") harness.runFrame();
      expect(read).toHaveBeenCalledOnce();
      expect(harness.indicator()?.dataset.inkbookOperation).toBe(kind);
      harness.feedback.dispose();
    },
  );
});

describe("PresentationOperationFeedback", () => {
  it("shows loading feedback only after the delay and removes it on completion", () => {
    const harness = createHarness();
    const operation = harness.feedback.begin("loading");

    expect(PRESENTATION_LOADING_FEEDBACK_DELAY_MS).toBe(500);
    expect(harness.delay()).toBe(PRESENTATION_LOADING_FEEDBACK_DELAY_MS);
    expect(harness.indicator()).toBeNull();
    harness.runTimer();
    expect(harness.indicator()).toBeNull();
    expect(harness.pendingFrames()).toBe(1);
    harness.runFrame();

    const indicator = harness.indicator();
    expect(indicator?.attributes.get("role")).toBe("status");
    expect(indicator?.attributes.get("aria-label")).toBe("Loading drawing");
    expect(indicator?.dataset.inkbookOperation).toBe("loading");
    expect(indicator?.style.insetBlockEnd).toBeUndefined();
    expect(indicator?.style.insetBlockStart).toBe("50px");
    expect(indicator?.style.insetInlineStart).toBe("300px");
    expect(indicator?.children[0]?.attributes.get("data-icon")).toBe("loader-circle");

    operation.finish();
    expect(harness.indicator()).toBeNull();
  });

  it("keeps fast operations invisible and ignores stale completion handles", () => {
    const harness = createHarness();
    const loading = harness.feedback.begin("loading");
    loading.finish();
    harness.runTimer();
    expect(harness.indicator()).toBeNull();

    const stale = harness.feedback.begin("loading");
    const saving = harness.feedback.begin("saving");
    expect(PRESENTATION_SAVING_FEEDBACK_DELAY_MS).toBe(150);
    expect(harness.delay()).toBe(PRESENTATION_SAVING_FEEDBACK_DELAY_MS);
    stale.finish();
    harness.runTimer();
    expect(harness.indicator()?.dataset.inkbookOperation).toBe("saving");
    expect(harness.pendingFrames()).toBe(0);

    saving.finish();
    expect(harness.indicator()).toBeNull();
  });

  it("cancels loading feedback between its delay and the next paint", () => {
    const harness = createHarness();
    const loading = harness.feedback.begin("loading");
    harness.runTimer();
    const finishedFrame = harness.pendingFrameHandles()[0];
    expect(harness.pendingFrames()).toBe(1);

    loading.finish();
    expect(harness.pendingFrames()).toBe(0);
    harness.runCapturedFrame(finishedFrame);
    expect(harness.indicator()).toBeNull();

    harness.feedback.begin("loading");
    harness.runTimer();
    const supersededFrame = harness.pendingFrameHandles()[0];
    expect(harness.pendingFrames()).toBe(1);
    harness.feedback.begin("saving");
    expect(harness.pendingFrames()).toBe(0);
    harness.runCapturedFrame(supersededFrame);
    expect(harness.indicator()).toBeNull();
  });

  it("disposes pending timers, pending frames, and visible feedback", () => {
    const harness = createHarness();
    harness.feedback.begin("loading");
    harness.feedback.dispose();
    harness.runTimer();
    expect(harness.indicator()).toBeNull();

    harness.feedback.begin("saving");
    expect(harness.delay()).toBeUndefined();
    harness.runTimer();
    expect(harness.indicator()).toBeNull();
  });

  it("does not paint loading feedback after disposal", () => {
    const harness = createHarness();
    harness.feedback.begin("loading");
    harness.runTimer();
    const disposedFrame = harness.pendingFrameHandles()[0];
    expect(harness.pendingFrames()).toBe(1);

    harness.feedback.dispose();
    expect(harness.pendingFrames()).toBe(0);
    harness.runCapturedFrame(disposedFrame);
    expect(harness.indicator()).toBeNull();
  });
});

describe("PresentationOperationFeedback loading handoff", () => {
  it("continues the original loading deadline before the next paint", () => {
    const harness = createHarness();
    const operation = harness.feedback.begin("loading", 700);
    expect(harness.delay()).toBe(200);
    harness.runTimer();
    expect(harness.indicator()).toBeNull();
    const frame = harness.pendingFrameHandles()[0];
    operation.finish();
    harness.runCapturedFrame(frame);
    expect(harness.indicator()).toBeNull();
  });

  it.each([500, 400])("shows an elapsed loading deadline synchronously (%s)", (startedAt) => {
    const harness = createHarness();
    const stale = harness.feedback.begin("loading", startedAt);
    expect(harness.delay()).toBeUndefined();
    expect(harness.pendingFrames()).toBe(0);
    expect(harness.indicator()?.dataset.inkbookOperation).toBe("loading");
    const current = harness.feedback.begin("loading", startedAt);
    stale.finish();
    expect(harness.indicator()?.dataset.inkbookOperation).toBe("loading");
    current.finish();
    expect(harness.indicator()).toBeNull();
  });

  it("disposes immediately resumed feedback and rejects later starts", () => {
    const harness = createHarness();
    const operation = harness.feedback.begin("loading", 100);
    harness.feedback.dispose();
    operation.finish();
    harness.feedback.begin("loading", 100).finish();
    expect(harness.indicator()).toBeNull();
    expect(harness.delay()).toBeUndefined();
    expect(harness.pendingFrames()).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1100])(
    "uses a fresh deadline for invalid or future timestamps (%s)",
    (startedAt) => {
      const harness = createHarness();
      harness.feedback.begin("loading", startedAt);
      expect(harness.delay()).toBe(500);
      expect(harness.indicator()).toBeNull();
    },
  );

  it("preserves the saving delay even with a previous start timestamp", () => {
    const harness = createHarness();
    harness.feedback.begin("saving", 100);
    expect(harness.delay()).toBe(150);
    expect(harness.indicator()).toBeNull();
    harness.runTimer();
    expect(harness.indicator()?.dataset.inkbookOperation).toBe("saving");
  });
});

function createHarness(onLoadingShown?: () => void) {
  const frameCallbacks = new Map<number, FrameRequestCallback>();
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, { readonly callback: () => void; readonly delay: number }>();
  let nextFrame = 0;
  let nextTimer = 0;
  const root = new FakePresentationElement();
  const ownerWindow = root.ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error("Missing owner window.");
  const mutableWindow = ownerWindow as unknown as {
    performance: { now: () => number };
    cancelAnimationFrame: (handle: number) => void;
    clearTimeout: (handle: number | undefined) => void;
    requestAnimationFrame: (callback: FrameRequestCallback) => number;
    setTimeout: (callback: () => void, delay: number) => number;
  };
  mutableWindow.performance = { now: () => 1000 };
  mutableWindow.cancelAnimationFrame = vi.fn((handle: number) => frames.delete(handle));
  mutableWindow.clearTimeout = vi.fn((handle: number | undefined) => {
    if (handle !== undefined) timers.delete(handle);
  });
  mutableWindow.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    const handle = ++nextFrame;
    frames.set(handle, callback);
    frameCallbacks.set(handle, callback);
    return handle;
  });
  mutableWindow.setTimeout = vi.fn((callback: () => void, delay: number) => {
    const handle = ++nextTimer;
    timers.set(handle, { callback, delay });
    return handle;
  });
  const feedback = new PresentationOperationFeedback(
    root as unknown as HTMLElement,
    onLoadingShown,
    workSchedulerFromFrames(ownerWindow),
  );
  return {
    root,
    delay: () => [...timers.values()][0]?.delay,
    feedback,
    indicator: () => root.getElementsByClassName("inkbook-operation-feedback").item(0),
    pendingFrameHandles: () => [...frames.keys()],
    pendingFrames: () => frames.size,
    runCapturedFrame: (handle: number | undefined) => {
      if (handle === undefined) throw new Error("Expected a captured animation frame.");
      frameCallbacks.get(handle)?.(0);
    },
    runFrame: () => {
      const next = frames.entries().next().value;
      if (next === undefined) return;
      frames.delete(next[0]);
      next[1](0);
    },
    runTimer: () => {
      const next = timers.entries().next().value;
      if (next === undefined) return;
      timers.delete(next[0]);
      next[1].callback();
    },
  };
}
