import { describe, expect, it, vi } from "vitest";

import {
  createPresentationFeedbackPositionLifecycle,
  resolvePresentationFeedbackPosition,
} from "../../../../src/obsidian/feedback";
import { FakePresentationElement } from "../../../fixtures/obsidian/presentation-dom";
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";

describe("presentation feedback position", () => {
  it("uses the lower center of the visible embed and native-scroll intersection", () => {
    expect(
      resolvePresentationFeedbackPosition(
        { bottom: 1_500, left: 100, right: 1_100, top: -400 },
        { bottom: 900, left: 0, right: 1_200, top: 100 },
      ),
    ).toEqual({ bottom: 616, left: 500, maxInlineSize: 976, visible: true });
  });

  it("hides feedback after the presentation leaves the visible scroll owner", () => {
    expect(
      resolvePresentationFeedbackPosition(
        { bottom: 2_000, left: 200, right: 1_000, top: 1_000 },
        { bottom: 900, left: 0, right: 1_200, top: 100 },
      ).visible,
    ).toBe(false);
  });

  it("centers the visible intersection during continuous scrolling in both directions", () => {
    const harness = createScrollingFeedback();
    const positions = [200, 100, 0, -100, -200, -300, -200, -100, 0, 100, 200, 400, 600, 700];
    for (const top of positions) {
      harness.top = top;
      harness.presentation.ownerDocument.dispatchEvent(new Event("scroll"));
      harness.runFrame();
      const visibleTop = Math.max(top, 100);
      const visibleBottom = Math.min(top + 300, 700);
      expect(harness.surface.style.visibility).toBe(
        visibleBottom > visibleTop ? "visible" : "hidden",
      );
      if (visibleBottom > visibleTop) {
        expect(Number.parseFloat(harness.surface.style.insetBlockStart) + top).toBe(
          (visibleTop + visibleBottom) / 2,
        );
      }
    }
    expect(harness.requests).toHaveBeenCalledWith(expect.any(Function), "input");
    harness.lifecycle.dispose();
  });

  it("reads fresh geometry before writes and coalesces scroll and resize notifications", () => {
    const harness = createScrollingFeedback();
    const reads = vi.spyOn(harness.presentation, "getBoundingClientRect");
    reads.mockClear();
    const order: string[] = [];
    reads.mockImplementation(() => {
      order.push("read");
      return { bottom: 500, height: 300, left: 100, right: 700, top: 200, width: 600 };
    });
    vi.spyOn(harness.surface.classList, "remove").mockImplementation(() => order.push("write"));
    for (let event = 0; event < 20; event += 1) {
      harness.presentation.ownerDocument.dispatchEvent(new Event("scroll"));
      harness.presentation.ownerDocument.defaultView?.dispatchEvent(new Event("resize"));
    }
    expect(reads).not.toHaveBeenCalled();
    expect(harness.frames.size).toBe(1);
    harness.runFrame();
    expect(reads).toHaveBeenCalledOnce();
    expect(order).toEqual(["read", "write"]);
    harness.presentation.ownerDocument.dispatchEvent(new Event("scroll"));
    harness.lifecycle.dispose();
    expect(harness.frames.size).toBe(0);
    harness.presentation.ownerDocument.dispatchEvent(new Event("scroll"));
    expect(harness.frames.size).toBe(0);
  });
});

function createScrollingFeedback() {
  const viewport = new FakePresentationElement();
  viewport.clientHeight = 800;
  const owner = new FakePresentationElement(viewport.ownerDocument);
  owner.clientHeight = 600;
  owner.scrollHeight = 2_000;
  const presentation = new FakePresentationElement(viewport.ownerDocument);
  owner.append(presentation);
  const surface = new FakePresentationElement(viewport.ownerDocument);
  let top = 200;
  vi.spyOn(owner, "getBoundingClientRect").mockReturnValue({
    bottom: 700,
    height: 600,
    left: 0,
    right: 800,
    top: 100,
    width: 800,
  });
  vi.spyOn(presentation, "getBoundingClientRect").mockImplementation(() => ({
    bottom: top + 300,
    height: 300,
    left: 100,
    right: 700,
    top,
    width: 600,
  }));
  const ownerWindow = viewport.ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error("Missing owner window.");
  vi.spyOn(ownerWindow, "getComputedStyle").mockReturnValue({
    overflowY: "auto",
  } as CSSStyleDeclaration);
  const frames = new Map<number, FrameRequestCallback>();
  let handle = 0;
  vi.spyOn(ownerWindow, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++handle, callback);
    return handle;
  });
  vi.spyOn(ownerWindow, "cancelAnimationFrame").mockImplementation((handle) =>
    frames.delete(handle),
  );
  const scheduler = workSchedulerFromFrames(ownerWindow);
  const requests = vi.spyOn(scheduler, "requestFrame");
  const lifecycle = createPresentationFeedbackPositionLifecycle(
    surface as unknown as HTMLElement,
    presentation as unknown as HTMLElement,
    "center",
    scheduler,
  );
  return {
    presentation,
    surface,
    lifecycle,
    requests,
    frames,
    set top(value: number) {
      top = value;
    },
    runFrame: () => {
      for (const [handle, callback] of [...frames]) {
        frames.delete(handle);
        callback(16);
      }
    },
  };
}

describe("detached presentation feedback", () => {
  it("shows a centered indicator immediately across widget insertion before observer delivery", () => {
    const harness = createDetachedFeedback();
    expect(harness.surface.classNames.has("inkbook-feedback-unmeasured")).toBe(true);
    harness.presentation.isConnected = true;
    expect(harness.surface.classNames.has("inkbook-feedback-unmeasured")).toBe(true);
    harness.runFrame();
    expect(harness.surface.style.visibility).toBe("visible");
    expect(harness.surface.classNames.has("inkbook-feedback-unmeasured")).toBe(false);
    expect(harness.surface.style.insetInlineStart).toBe("300px");
    expect(harness.surface.style.insetBlockStart).toBe("50px");
    harness.lifecycle.dispose();
  });

  it("retains relative positioning if the initial frame precedes insertion", () => {
    const harness = createDetachedFeedback();
    harness.runFrame();
    expect(harness.surface.classNames.has("inkbook-feedback-unmeasured")).toBe(true);
    harness.lifecycle.dispose();
  });

  it("hides an inserted offscreen presentation instead of retaining fallback visibility", () => {
    const harness = createDetachedFeedback();
    harness.presentation.isConnected = true;
    vi.spyOn(harness.presentation, "getBoundingClientRect").mockReturnValue({
      bottom: 400,
      height: 100,
      left: 0,
      right: 600,
      top: 300,
      width: 600,
    });
    harness.runFrame();
    expect(harness.surface.style.visibility).toBe("hidden");
    harness.lifecycle.dispose();
  });

  it("cancels the initial positioning frame when the detached widget is disposed", () => {
    const harness = createDetachedFeedback();
    harness.lifecycle.dispose();
    expect(harness.cancelFrame).toHaveBeenCalledWith(42);
    harness.presentation.isConnected = true;
    harness.runFrame();
    expect(harness.surface.classNames.has("inkbook-feedback-unmeasured")).toBe(true);
  });
});

function createDetachedFeedback() {
  const presentation = new FakePresentationElement();
  presentation.isConnected = false;
  const surface = new FakePresentationElement(presentation.ownerDocument);
  const ownerWindow = presentation.ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error("Missing owner window.");
  const cancelFrame = vi.spyOn(ownerWindow, "cancelAnimationFrame");
  let frame: FrameRequestCallback = () => undefined;
  vi.spyOn(ownerWindow, "requestAnimationFrame").mockImplementation((callback) => {
    frame = callback;
    return 42;
  });
  const lifecycle = createPresentationFeedbackPositionLifecycle(
    surface as unknown as HTMLElement,
    presentation as unknown as HTMLElement,
    "center",
    workSchedulerFromFrames(ownerWindow),
  );
  return { cancelFrame, lifecycle, presentation, runFrame: () => frame(16), surface };
}
