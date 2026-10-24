// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PRESENTATION_OPENING_FEEDBACK_DELAY_MS,
  PRESENTATION_OPENING_FEEDBACK_MIN_VISIBLE_MS,
  PresentationOperationFeedback,
} from "../../../../../src/obsidian/embeds/presentation/presentation-operation-feedback";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";

let harness: ReturnType<typeof createHarness>;
beforeEach(() => {
  harness = createHarness();
});
afterEach(() => {
  harness.feedback.dispose();
  harness.root.remove();
  vi.restoreAllMocks();
});

describe("manual opening feedback", () => {
  it("leaves fast openings free of loading feedback", () => {
    const operation = harness.feedback.begin("opening");
    expect(harness.root.children).toHaveLength(0);
    expect(harness.backdrop()).toBeNull();
    expect(harness.status()).toBeNull();
    expect(PRESENTATION_OPENING_FEEDBACK_DELAY_MS).toBe(250);
    expect(harness.timer.mock.calls[0]?.[1]).toBe(PRESENTATION_OPENING_FEEDBACK_DELAY_MS);
    operation.finish();
    harness.runTimer();
    harness.runFrame();
    expect(harness.status()).toBeNull();
    expect(harness.backdrop()).toBeNull();
    expect(harness.root.children).toHaveLength(0);
  });

  it("retains a shown overlay briefly after readiness, then fades the complete surface out", async () => {
    const operation = harness.feedback.begin("opening");
    harness.runTimer();
    expect(harness.status()).toBeNull();
    expect(harness.frames.size).toBe(1);
    harness.runFrame();
    const status = harness.status()!;
    const backdrop = harness.backdrop()!;
    expect(status.getAttribute("aria-label")).toBe("Loading drawing");
    expect(status.getAnimations()).toHaveLength(1);
    operation.finish();
    expect(harness.status()).toBeNull();
    expect(status.isConnected).toBe(true);
    expect(status.getAttribute("aria-hidden")).toBe("true");
    const hold = harness.timer.mock.calls[harness.timer.mock.calls.length - 1]?.[1];
    expect(hold).toBeGreaterThan(0);
    expect(hold).toBeLessThanOrEqual(PRESENTATION_OPENING_FEEDBACK_MIN_VISIBLE_MS);
    harness.runTimer();
    expect(status.isConnected).toBe(true);
    backdrop.getAnimations()[0]!.finish();
    await Promise.resolve();
    expect(status.getAnimations()).toHaveLength(0);
    expect(status.isConnected).toBe(false);
    expect(harness.root.children).toHaveLength(0);
  });
});

describe("opening completion policy", () => {
  it("does not add another hold when an overlay has already been visible long enough", async () => {
    const now = vi.spyOn(window.performance, "now").mockReturnValue(0);
    const operation = harness.feedback.begin("opening");
    harness.runTimer();
    harness.runFrame();
    now.mockReturnValue(PRESENTATION_OPENING_FEEDBACK_MIN_VISIBLE_MS + 1);
    operation.finish();
    expect(harness.timer).toHaveBeenCalledOnce();
    harness.backdrop()!.getAnimations()[0]!.finish();
    await Promise.resolve();
    expect(harness.root.children).toHaveLength(0);
  });

  it("immediately clears shown feedback for failure, without retaining the loading visual", () => {
    const operation = harness.feedback.begin("opening");
    harness.runTimer();
    harness.runFrame();
    operation.finish("immediate");
    expect(harness.status()).toBeNull();
    expect(harness.root.children).toHaveLength(0);
    expect(harness.timer).toHaveBeenCalledOnce();
  });
});

describe("opening feedback lifecycle", () => {
  it("rejects a threshold-frame completion after replacement or disposal", () => {
    harness.feedback.begin("opening");
    harness.runTimer();
    const staleFrame = [...harness.frames.values()][0]!;
    harness.feedback.begin("opening");
    staleFrame(0);
    expect(harness.root.children).toHaveLength(0);
    expect(harness.status()).toBeNull();
    harness.runTimer();
    harness.feedback.dispose();
    staleFrame(0);
    expect(harness.root.children).toHaveLength(0);
    expect(harness.frames.size).toBe(0);
    expect(harness.status()).toBeNull();
  });

  it("ignores a stale visual-hold callback after the next operation starts", () => {
    const operation = harness.feedback.begin("opening");
    harness.runTimer();
    harness.runFrame();
    const oldBackdrop = harness.backdrop()!;
    operation.finish();
    const retiredHold = harness.timer.mock.calls[
      harness.timer.mock.calls.length - 1
    ]?.[0] as () => void;
    harness.feedback.begin("opening");
    retiredHold();
    expect(oldBackdrop.isConnected).toBe(false);
    expect(oldBackdrop.getAnimations()).toHaveLength(0);
    expect(harness.root.children).toHaveLength(0);
    expect(harness.backdrop()).toBeNull();
    expect(harness.frames.size).toBe(0);
    harness.runTimer();
    harness.runFrame();
    expect(harness.status()).not.toBeNull();
  });

  it("honors reduced motion set before delayed feedback appears", () => {
    const operation = harness.feedback.begin("opening");
    harness.root.dataset.inkbookMotion = "reduced";
    harness.runTimer();
    harness.runFrame();
    const status = harness.status()!;
    expect(status.getAnimations()).toHaveLength(0);
    expect(status.firstElementChild?.getAnimations()).toHaveLength(0);
    operation.finish();
    expect(harness.status()).toBeNull();
    expect(harness.backdrop()).toBeNull();
  });
});

it("settles a retired overlay immediately when reduced motion is enabled", async () => {
  const operation = harness.feedback.begin("opening");
  harness.runTimer();
  harness.runFrame();
  operation.finish();
  expect(harness.backdrop()).not.toBeNull();
  harness.timer.mockRestore();
  harness.root.dataset.inkbookMotion = "reduced";
  await vi.waitFor(() => expect(harness.root.children).toHaveLength(0));
});

function createHarness() {
  installObsidianDomHelpers();
  const root = document.body.createDiv({ cls: "inkbook-root" });
  root.dataset.inkbookMotion = "full";
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 100));
  let show: (() => void) | undefined;
  const timer = vi.spyOn(window, "setTimeout").mockImplementation((callback) => {
    if (typeof callback === "function") show = callback;
    return 1 as unknown as ReturnType<typeof window.setTimeout>;
  });
  const frames = new Map<number, FrameRequestCallback>();
  let handle = 0;
  const feedback = new PresentationOperationFeedback(
    root,
    undefined,
    workSchedulerFromFrames({
      requestAnimationFrame: (callback) => {
        frames.set(++handle, callback);
        return handle;
      },
      cancelAnimationFrame: (id) => frames.delete(id),
    }),
  );
  return {
    backdrop: () => root.querySelector<HTMLElement>(".inkbook-operation-backdrop"),
    feedback,
    frames,
    root,
    status: () => document.querySelector<HTMLElement>('[role="status"]:not([aria-hidden="true"])'),
    timer,
    runTimer: () => show?.(),
    runFrame: () => {
      for (const [id, callback] of frames) {
        frames.delete(id);
        callback(0);
      }
    },
  };
}
