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
});

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
