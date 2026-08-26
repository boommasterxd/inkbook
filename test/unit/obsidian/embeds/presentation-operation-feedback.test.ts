import { describe, expect, it, vi } from "vitest";

import {
  PRESENTATION_LOADING_FEEDBACK_DELAY_MS,
  PRESENTATION_SAVING_FEEDBACK_DELAY_MS,
  PresentationOperationFeedback,
} from "../../../../src/obsidian/embeds/presentation-operation-feedback";
import { FakePresentationElement } from "../../../fixtures/obsidian/presentation-dom";

describe("PresentationOperationFeedback", () => {
  it("shows loading feedback only after the delay and removes it on completion", () => {
    const harness = createHarness();
    const operation = harness.feedback.begin("loading");

    expect(harness.delay()).toBe(PRESENTATION_LOADING_FEEDBACK_DELAY_MS);
    expect(harness.indicator()).toBeNull();
    harness.runTimer();

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
    expect(harness.delay()).toBe(PRESENTATION_SAVING_FEEDBACK_DELAY_MS);
    stale.finish();
    harness.runTimer();
    expect(harness.indicator()?.dataset.inkbookOperation).toBe("saving");

    saving.finish();
    expect(harness.indicator()).toBeNull();
  });

  it("disposes pending timers and visible feedback", () => {
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
});

function createHarness() {
  const timers = new Map<number, { readonly callback: () => void; readonly delay: number }>();
  let nextTimer = 0;
  const root = new FakePresentationElement();
  const ownerWindow = root.ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error("Missing owner window.");
  const mutableWindow = ownerWindow as unknown as {
    clearTimeout: (handle: number | undefined) => void;
    setTimeout: (callback: () => void, delay: number) => number;
  };
  mutableWindow.clearTimeout = vi.fn((handle: number | undefined) => {
    if (handle !== undefined) timers.delete(handle);
  });
  mutableWindow.setTimeout = vi.fn((callback: () => void, delay: number) => {
    const handle = ++nextTimer;
    timers.set(handle, { callback, delay });
    return handle;
  });
  const feedback = new PresentationOperationFeedback(root as unknown as HTMLElement);
  return {
    delay: () => [...timers.values()][0]?.delay,
    feedback,
    indicator: () => root.getElementsByClassName("inkbook-operation-feedback").item(0),
    runTimer: () => {
      const next = timers.entries().next().value;
      if (next === undefined) return;
      timers.delete(next[0]);
      next[1].callback();
    },
  };
}
