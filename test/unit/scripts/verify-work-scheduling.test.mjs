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

it("rejects assigned aliases, indirect invocation, and native callbacks", () => {
  const violations = validateWorkScheduling([
    source(`
      let later;
      later = ownerWindow.requestAnimationFrame;
      later.call(ownerWindow, run);
      later.apply(ownerWindow, [run]);
      const schedule = ownerWindow.setTimeout.bind(ownerWindow);
      schedule.call(null, run, 0);
      Promise.resolve().then(ownerWindow.queueMicrotask);
      callbacks.forEach(ownerWindow.requestIdleCallback.bind(ownerWindow));
      Reflect.apply(ownerWindow.setInterval, ownerWindow, [run, 1]);
    `),
  ]);

  expect(violations).toHaveLength(6);
  expect(violations.map((item) => item.match(/native (\w+)/u)?.[1])).toEqual([
    "requestAnimationFrame",
    "requestAnimationFrame",
    "setTimeout",
    "queueMicrotask",
    "requestIdleCallback",
    "setInterval",
  ]);
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
  expect(validateWorkScheduling([source("Promise.resolve(result).then(adoptResult);")])).toEqual(
    [],
  );
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
  expect(
    validateWorkScheduling([
      source(
        "class LongPress { schedule() { setTimeout(requestAnimationFrame, 500); } }",
        "src/obsidian/embeds/active-editor/long-press.ts",
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

it("rejects numeric local work limits without requiring a deadline variable name", () => {
  const violations = validateWorkScheduling([
    source(`
      const stop = performance.now() + 4;
      let limit = 0;
      limit = clock.now() + 5;
      while (performance.now() - start < 6) doWork();
      const animationEndsAt = performance.now() + animationDurationMs;
      const wallClock = Math.floor(performance.timeOrigin + performance.now());
      const sharedDeadline = workScheduler.deadline();
    `),
  ]);
  expect(violations).toHaveLength(3);
  expect(violations.every((item) => item.includes("local work deadline"))).toBe(true);
});

it("permits only named native call sites in exact boundary adapters", () => {
  const windowAdapter = [...NATIVE_WORK_ADAPTERS][0];
  const workerAdapter = [...NATIVE_WORK_ADAPTERS][1];
  expect(
    validateWorkScheduling([
      source(
        `class WindowTaskQueue {
          #ensureChannel() { new MessageChannel(); }
          #scheduleTimeout() { ownerWindow.setTimeout(run, 0); }
        }
        function createWindowWorkScheduler() { ownerWindow.requestAnimationFrame(run); }`,
        windowAdapter,
      ),
      source(
        `function createWorkerWorkScheduler() {
          self.setTimeout(run, 0);
          timing.setTimeout(run, 0);
          timing.setTimeout(run, 0);
        }`,
        workerAdapter,
      ),
    ]),
  ).toEqual([]);
  const violations = validateWorkScheduling([
    source(
      `class WindowTaskQueue {
        #ensureChannel() { new MessageChannel(); new MessageChannel(); }
        #post() { requestAnimationFrame(run); }
      }
      function createWindowWorkScheduler() { queueMicrotask(run); }`,
      windowAdapter,
    ),
    source("requestAnimationFrame(run);", `${windowAdapter.slice(0, -3)}-copy.ts`),
  ]);
  expect(violations).toHaveLength(4);
});
