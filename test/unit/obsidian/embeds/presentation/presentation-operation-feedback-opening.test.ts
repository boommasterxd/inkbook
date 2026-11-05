// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PRESENTATION_OPENING_FEEDBACK_DELAY_MS,
  PRESENTATION_OPENING_FEEDBACK_MIN_VISIBLE_MS,
  PresentationOperationFeedback,
} from "../../../../../src/obsidian/embeds/presentation/presentation-operation-feedback";
import { createOperationFeedbackPresentation } from "../../../../fixtures/obsidian/operation-feedback-presentation";
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
  it("keeps the backdrop inside the owned canvas across locked, opening and exit phases", async () => {
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(document.documentElement, "clientWidth", {
      configurable: true,
      value: 1000,
    });
    const preview = harness.root.createDiv({ cls: "inkbook-locked-preview" });
    const rootBounds = vi.spyOn(harness.root, "getBoundingClientRect");
    rootBounds.mockReturnValue(new DOMRect(100, 20, 600, 500));
    vi.spyOn(preview, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 20, 600, 500));
    const operation = harness.feedback.begin("opening");
    harness.runTimer();
    harness.runFrame();
    const backdrop = harness.backdrop()!;
    expect(backdrop.parentElement).toBe(preview);

    const chrome = harness.root.createDiv({ cls: "inkbook-editor-chrome" });
    const toolbar = chrome.createDiv({ cls: "inkbook-editor-chrome-host" });
    const canvas = chrome.createDiv({ cls: "inkbook-background-container" });
    vi.spyOn(toolbar, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 200, 600, 48));
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 600, 420));
    harness.root.classList.add("inkbook-presentation-activating");
    rootBounds.mockReturnValue(new DOMRect(100, 20, 600, 300));
    preview.hidden = true;
    harness.timer.mockRestore();
    await vi.waitFor(() => expect(backdrop.parentElement).toBe(canvas));
    expect(canvas.contains(toolbar)).toBe(false);
    harness.runFrame();
    expect(harness.status()?.style.insetBlockStart).toBe("210px");
    rootBounds.mockReturnValue(new DOMRect(100, 20, 600, 500));
    document.dispatchEvent(new Event("scroll"));
    harness.runFrame();
    expect(harness.status()?.style.insetBlockStart).toBe("310px");
    expect(harness.status()?.style.insetInlineStart).toBe("400px");
    operation.finish();
    expect(backdrop.parentElement).toBe(canvas);
    harness.feedback.finish();
    expect(backdrop.parentElement).toBe(canvas);
    backdrop.getAnimations()[0]!.finish();
    await Promise.resolve();
    expect(backdrop.isConnected).toBe(false);
    expect(harness.frames.size).toBe(0);
    Reflect.deleteProperty(document.documentElement, "clientHeight");
    Reflect.deleteProperty(document.documentElement, "clientWidth");
  });

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
  const root = createOperationFeedbackPresentation();
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
