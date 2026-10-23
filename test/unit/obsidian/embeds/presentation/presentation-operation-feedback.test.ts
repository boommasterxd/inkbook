// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import {
  PRESENTATION_LOADING_FEEDBACK_DELAY_MS,
  PRESENTATION_SAVING_FEEDBACK_DELAY_MS,
  PresentationOperationFeedback,
} from "../../../../../src/obsidian/embeds/presentation/presentation-operation-feedback";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { FakePresentationElement } from "../../../../fixtures/obsidian/presentation-dom";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";

describe("PresentationOperationFeedback live motion preferences", () => {
  it.each(["loading", "saving"] as const)(
    "updates an existing %s spinner on device and system preference changes",
    async (kind) => {
      installObsidianDomHelpers();
      const root = document.body.createDiv({ cls: "inkbook-root" });
      if (kind === "loading") root.dataset.inkbookMotion = "full";
      vi.spyOn(root, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 100));
      const query = Object.assign(new EventTarget(), { matches: false });
      const removeListener = vi.spyOn(query, "removeEventListener");
      vi.spyOn(window, "matchMedia").mockReturnValue(query as unknown as MediaQueryList);
      const disconnect = vi.spyOn(window.MutationObserver.prototype, "disconnect");
      let showSaving: (() => void) | undefined;
      const scheduleSaving = vi.spyOn(window, "setTimeout").mockImplementation((callback) => {
        if (typeof callback === "function") showSaving = callback;
        return 1 as unknown as ReturnType<typeof window.setTimeout>;
      });
      const feedback = new PresentationOperationFeedback(
        root,
        undefined,
        workSchedulerFromFrames({ requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} }),
      );
      try {
        const operation = feedback.begin(kind, performance.now() - 1000);
        showSaving?.();
        scheduleSaving.mockRestore();
        const icon = document.querySelector<HTMLElement>(".inkbook-operation-feedback-icon")!;
        expect(icon.getAnimations()).toHaveLength(1);
        root.dataset.inkbookMotion = "reduced";
        await vi.waitFor(() => expect(icon.getAnimations()).toHaveLength(0));
        expect(document.querySelector('[role="status"]')).not.toBeNull();
        root.dataset.inkbookMotion = "full";
        await vi.waitFor(() => expect(icon.getAnimations()).toHaveLength(1));
        query.matches = true;
        query.dispatchEvent(new Event("change"));
        expect(icon.getAnimations()).toHaveLength(1);
        delete root.dataset.inkbookMotion;
        await vi.waitFor(() => expect(icon.getAnimations()).toHaveLength(0));
        query.matches = false;
        query.dispatchEvent(new Event("change"));
        expect(icon.getAnimations()).toHaveLength(1);
        operation.finish();
        expect(icon.getAnimations()).toHaveLength(0);
        expect(icon.isConnected).toBe(false);
        expect(disconnect).toHaveBeenCalledOnce();
        feedback.begin("loading", performance.now() - 1000);
        const replacement = document.querySelector<HTMLElement>(
          ".inkbook-operation-feedback-icon",
        )!;
        expect(replacement.getAnimations()).toHaveLength(1);
        feedback.dispose();
        expect(replacement.getAnimations()).toHaveLength(0);
        expect(replacement.isConnected).toBe(false);
        expect(removeListener).toHaveBeenCalledWith("change", expect.any(Function));
        root.dataset.inkbookMotion = "full";
        query.dispatchEvent(new Event("change"));
        await Promise.resolve();
        expect(icon.getAnimations()).toHaveLength(0);
        expect(replacement.getAnimations()).toHaveLength(0);
        expect(disconnect).toHaveBeenCalledTimes(2);
      } finally {
        feedback.dispose();
        root.remove();
        vi.restoreAllMocks();
      }
    },
  );
});

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
  it("owns feedback in the presentation window body and synchronizes presentation styling", () => {
    const harness = createHarness();
    harness.root.dataset.inkbookScheme = "dark";
    harness.root.dataset.inkbookMotion = "reduced";
    const operation = harness.feedback.begin("loading", 0);
    const host = harness.indicator()?.parentElement;
    expect(host?.parentElement).toBe(harness.body);
    expect(host?.classNames.has("inkbook-root")).toBe(true);
    expect(host?.classNames.has("inkbook-operation-feedback-host")).toBe(true);
    expect(host?.dataset.inkbookFeedbackSpace).toBe("viewport");
    expect(host?.dataset.inkbookScheme).toBe("dark");
    expect(host?.dataset.inkbookMotion).toBe("reduced");
    expect(harness.root.children).toHaveLength(0);
    expect(harness.observeStyle).toHaveBeenCalledWith(harness.root, {
      attributes: true,
      attributeFilter: ["data-inkbook-scheme", "data-inkbook-motion"],
    });
    harness.root.dataset.inkbookScheme = "light";
    delete harness.root.dataset.inkbookMotion;
    harness.syncStyle();
    expect(host?.dataset.inkbookScheme).toBe("light");
    expect(host?.dataset.inkbookMotion).toBeUndefined();
    operation.finish();
    expect(harness.body.children).toEqual([harness.root]);
    expect(harness.disconnectStyle).toHaveBeenCalledOnce();
    harness.feedback.dispose();
  });

  it("moves the same detached feedback host to its owning body after the first measurement", () => {
    const harness = createHarness();
    harness.root.remove();
    harness.feedback.begin("loading", 0);
    const indicator = harness.indicator();
    const host = indicator?.parentElement;
    expect(host?.parentElement).toBe(harness.root);
    expect(host?.dataset.inkbookFeedbackSpace).toBe("presentation");
    expect(indicator?.classNames.has("inkbook-feedback-unmeasured")).toBe(true);
    harness.runFrame();
    expect(host?.parentElement).toBe(harness.root);
    harness.body.append(harness.root);
    harness.root.ownerDocument.dispatchEvent(new Event("scroll"));
    harness.runFrame();
    expect(harness.indicator()).toBe(indicator);
    expect(host?.parentElement).toBe(harness.body);
    expect(host?.dataset.inkbookFeedbackSpace).toBe("viewport");
    expect(indicator?.classNames.has("inkbook-feedback-unmeasured")).toBe(false);
    harness.feedback.dispose();
    expect(harness.body.children).toEqual([harness.root]);
    expect(harness.pendingFrames()).toBe(0);
  });

  it.each(["replacement", "disposal"])("releases visible feedback resources on %s", (action) => {
    const harness = createHarness();
    harness.feedback.begin("loading", 0);
    const host = harness.indicator()?.parentElement;
    harness.root.ownerDocument.dispatchEvent(new Event("scroll"));
    expect(harness.pendingFrames()).toBe(1);
    if (action === "replacement") harness.feedback.begin("saving");
    else harness.feedback.dispose();
    expect(host?.parentElement).toBeNull();
    expect(harness.disconnectStyle).toHaveBeenCalledOnce();
    expect(harness.disconnectResize).toHaveBeenCalledOnce();
    expect(harness.pendingFrames()).toBe(0);
    harness.root.ownerDocument.dispatchEvent(new Event("scroll"));
    harness.root.ownerDocument.defaultView?.dispatchEvent(new Event("resize"));
    expect(harness.pendingFrames()).toBe(0);
    harness.feedback.dispose();
    expect(harness.delay()).toBeUndefined();
  });

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
    expect(indicator?.attributes.get("aria-atomic")).toBe("true");
    expect(indicator?.children[0]?.attributes.get("aria-hidden")).toBe("true");
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
  const body = new FakePresentationElement();
  const root = new FakePresentationElement(body.ownerDocument);
  body.append(root);
  const ownerWindow = root.ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error("Missing owner window.");
  const observers = createObserverHarness(ownerWindow);
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
    body,
    ...observers,
    root,
    delay: () => [...timers.values()][0]?.delay,
    feedback,
    indicator: () =>
      (root.isConnected ? body : root).getElementsByClassName("inkbook-operation-feedback").item(0),
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

function createObserverHarness(ownerWindow: Window) {
  const observeStyle = vi.fn();
  const disconnectStyle = vi.fn();
  const disconnectResize = vi.fn();
  let syncStyle = () => undefined;
  Object.assign(ownerWindow, {
    MutationObserver: class {
      public constructor(callback: () => undefined) {
        syncStyle = callback;
      }
      public observe = observeStyle;
      public disconnect = disconnectStyle;
    },
    ResizeObserver: class {
      public observe = vi.fn();
      public disconnect = disconnectResize;
    },
  });
  return { observeStyle, disconnectStyle, disconnectResize, syncStyle: () => syncStyle() };
}
