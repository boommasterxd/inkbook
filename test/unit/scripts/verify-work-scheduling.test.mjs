import { expect, it } from "vitest";

import {
  NATIVE_WORK_ADAPTERS,
  validateWorkScheduling,
} from "../../../scripts/verify-work-scheduling.mjs";

const source = (content, path = "src/obsidian/embeds/new-scheduler.ts") => ({ content, path });

it("rejects native frame, idle, channel, and zero-delay work handoffs", () => {
  const violations = validateWorkScheduling([
    source(`
      requestAnimationFrame(run);
      ownerWindow?.requestAnimationFrame(run);
      ownerWindow["requestIdleCallback"]?.(run);
      new MessageChannel();
      new ownerWindow.MessageChannel();
      setTimeout(run, 0);
      ownerWindow.setTimeout(run);
      ownerWindow.setTimeout(run, -1);
      ownerWindow.setInterval(run, 1);
      scheduler.postTask(run);
    `),
  ]);

  expect(violations).toHaveLength(10);
  expect(violations.map((item) => item.split(": native ")[1])).toEqual([
    "requestAnimationFrame scheduling must use the shared work scheduler.",
    "requestAnimationFrame scheduling must use the shared work scheduler.",
    "requestIdleCallback scheduling must use the shared work scheduler.",
    "MessageChannel scheduling must use the shared work scheduler.",
    "MessageChannel scheduling must use the shared work scheduler.",
    "setTimeout scheduling must use the shared work scheduler.",
    "setTimeout scheduling must use the shared work scheduler.",
    "setTimeout scheduling must use the shared work scheduler.",
    "setInterval scheduling must use the shared work scheduler.",
    "postTask scheduling must use the shared work scheduler.",
  ]);
});

it("follows common native aliases and bracket property access", () => {
  const violations = validateWorkScheduling([
    source(`
      const later = ownerWindow.requestAnimationFrame.bind(ownerWindow);
      const { requestIdleCallback: whenIdle, setTimeout: delay } = ownerWindow;
      const Channel = ownerWindow["MessageChannel"];
      later(run);
      whenIdle(run);
      delay(run, +0);
      new Channel();
    `),
  ]);

  expect(violations).toHaveLength(4);
});

it("keeps listed semantic timers while blocking new work timers and microtasks", () => {
  expect(
    validateWorkScheduling([
      source(
        "class LongPress { schedule() { ownerWindow.setTimeout(expire, 500); } }",
        "src/obsidian/embeds/active-editor/long-press.ts",
      ),
    ]),
  ).toEqual([]);
  expect(validateWorkScheduling([source("setTimeout(runNextSlice, 1);")])).toHaveLength(1);
  expect(validateWorkScheduling([source("queueMicrotask(runNextSlice);")])).toHaveLength(1);
});

it("permits only exact semantic host turn and microtask sites", () => {
  expect(
    validateWorkScheduling([
      source(
        "class CanvasTouchBoundary { #handlePointerTerminal() { setTimeout(expire, 0); } }",
        "src/obsidian/embeds/canvas-touch-boundary.ts",
      ),
      source(
        "class InkbookLoadingPreviewWidget { toDOM() { queueMicrotask(notify); } }",
        "src/obsidian/embeds/live-preview-loading-widget.ts",
      ),
      source(
        "class WindowRefreshRateProfiles { #start() { requestAnimationFrame(sample); } }",
        "src/obsidian/performance/window-refresh-rate.ts",
      ),
    ]),
  ).toEqual([]);
  expect(
    validateWorkScheduling([
      source(
        "class CanvasTouchBoundary { #handlePointerTerminal() { setTimeout(one, 0); setTimeout(two, 0); } }",
        "src/obsidian/embeds/canvas-touch-boundary.ts",
      ),
    ]),
  ).toHaveLength(1);
});

it("rejects private work deadlines while allowing the shared scheduler deadline", () => {
  const violations = validateWorkScheduling([
    source(`
      const deadline = performance.now() + sliceBudgetMs();
      let sliceStarted = clock.now();
      sliceStarted = clock.now();
      this.#deadline = clock.now() + budgetMs();
      const sharedDeadline = workScheduler.deadline();
      void sharedDeadline;
    `),
  ]);
  expect(violations).toHaveLength(4);
  expect(violations.every((item) => item.includes("local work deadline"))).toBe(true);
});

it("permits native scheduling only in exact boundary adapters", () => {
  const adapter = [...NATIVE_WORK_ADAPTERS][0];
  expect(
    validateWorkScheduling([
      source("new MessageChannel(); requestAnimationFrame(run); setTimeout(run, 0);", adapter),
    ]),
  ).toEqual([]);
  expect(
    validateWorkScheduling([
      source("requestAnimationFrame(run);", `${adapter.slice(0, -3)}-copy.ts`),
    ]),
  ).toHaveLength(1);
});
