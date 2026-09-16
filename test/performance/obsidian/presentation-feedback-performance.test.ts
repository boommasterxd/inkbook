import { expect, it } from "vitest";

import { PresentationOperationFeedback } from "../../../src/obsidian/embeds/presentation-operation-feedback";
import { FakePresentationElement } from "../../fixtures/obsidian/presentation-dom";
import { expectTiming } from "../timing-assertions";
import { interactionP99, INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";

it("hands off overdue loading feedback synchronously within the frame budget", async ({
  annotate,
}) => {
  const root = new FakePresentationElement();
  const ownerWindow = root.ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error("Missing owner window.");
  let scheduledWork = 0;
  Object.assign(ownerWindow, {
    performance: { now: () => 1000 },
    requestAnimationFrame: () => ++scheduledWork,
    setTimeout: () => ++scheduledWork,
  });
  const feedback = new PresentationOperationFeedback(root as unknown as HTMLElement);
  const durations: number[] = [];
  let invalidIndicators = 0;
  let retainedIndicators = 0;
  for (let sample = -100; sample < INTERACTION_REFRESH_PROFILE.sampleCount; sample += 1) {
    const started = performance.now();
    const operation = feedback.begin("loading", 0);
    const indicators = root.getElementsByClassName("inkbook-operation-feedback");
    const indicator = indicators.item(0);
    if (
      indicators.length !== 1 ||
      indicator?.style.insetBlockStart !== "50px" ||
      indicator.style.insetInlineStart !== "300px"
    ) {
      invalidIndicators += 1;
    }
    operation.finish();
    if (sample >= 0) durations.push(performance.now() - started);
    retainedIndicators += root.children.length;
  }
  feedback.dispose();
  expect(invalidIndicators).toBe(0);
  expect(retainedIndicators).toBe(0);
  expect(scheduledWork).toBe(0);
  const p99 = interactionP99(durations);
  expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
  await annotate(`Overdue loading feedback handoff p99=${p99.toFixed(3)} ms`, "performance");
});

it("positions detached loading feedback after attachment within the frame budget", async ({
  annotate,
}) => {
  const root = new FakePresentationElement();
  const ownerWindow = root.ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error("Missing owner window.");
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let timers = 0;
  Object.assign(ownerWindow, {
    performance: { now: () => 1000 },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (handle: number) => frames.delete(handle),
    setTimeout: () => ++timers,
  });
  const durations: number[] = [];
  let invalidPositions = 0;
  let retainedResources = 0;
  for (let sample = -100; sample < INTERACTION_REFRESH_PROFILE.sampleCount; sample += 1) {
    root.isConnected = false;
    const feedback = new PresentationOperationFeedback(root as unknown as HTMLElement);
    const started = performance.now();
    feedback.begin("loading", 0);
    const indicators = root.getElementsByClassName("inkbook-operation-feedback");
    const indicator = indicators.item(0);
    if (
      indicators.length !== 1 ||
      indicator?.classNames.has("inkbook-feedback-unmeasured") !== true ||
      frames.size !== 1
    ) {
      invalidPositions += 1;
    }
    root.isConnected = true;
    for (const [handle, callback] of frames) {
      frames.delete(handle);
      callback(0);
    }
    if (
      indicator?.style.insetBlockStart !== "50px" ||
      indicator.style.insetInlineStart !== "300px"
    ) {
      invalidPositions += 1;
    }
    feedback.dispose();
    if (sample >= 0) durations.push(performance.now() - started);
    retainedResources += root.children.length + frames.size;
  }
  expect(invalidPositions).toBe(0);
  expect(retainedResources).toBe(0);
  expect(timers).toBe(0);
  const p99 = interactionP99(durations);
  expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
  await annotate(`Detached loading feedback attachment p99=${p99.toFixed(3)} ms`, "performance");
});
