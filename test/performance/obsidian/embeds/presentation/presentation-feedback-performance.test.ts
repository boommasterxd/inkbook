import { expect, it, vi } from "vitest";
import type { FileManager, Vault } from "obsidian";

import {
  createBuiltInDeviceSettings,
  createBuiltInSettings,
} from "../../../../../src/domain/settings";
import { PresentationOperationFeedback } from "../../../../../src/obsidian/embeds/presentation/presentation-operation-feedback";
import type { PresentationAttachment } from "../../../../../src/obsidian/embeds/presentation/presentation-port";
import { ObsidianWorkspaceRuntime } from "../../../../../src/obsidian/embeds/workspace/workspace-runtime";
import type { ObsidianEmbedActions } from "../../../../../src/obsidian/commands";
import { InkbookFeedbackManager } from "../../../../../src/obsidian/feedback";
import { ColorSchemeBroadcaster } from "../../../../../src/obsidian/theme/color-scheme";
import { FakePresentationElement } from "../../../../fixtures/obsidian/presentation-dom";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";

it("releases presentation motion listeners on detach before workspace unload", () => {
  const { root, ownerWindow } = createFramedPresentation();
  const listeners = new Set<EventListenerOrEventListenerObject>();
  Object.assign(ownerWindow, {
    matchMedia: () => ({
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) =>
        listeners.add(listener),
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) =>
        listeners.delete(listener),
    }),
  });
  const settings = {
    device: createBuiltInDeviceSettings(),
    vault: { ...createBuiltInSettings(), refreshRatePreference: 120 as const },
  };
  const runtime = new ObsidianWorkspaceRuntime(
    {} as Vault,
    {} as FileManager,
    new ColorSchemeBroadcaster({ getColorScheme: () => "light" }),
    () => settings,
    {} as ObsidianEmbedActions,
    {
      fallbackOwnerWindow: () => ownerWindow,
      manager: new InkbookFeedbackManager(),
      onOpenSettings: () => undefined,
      onOpenShortcuts: () => undefined,
    },
  );
  try {
    for (let generation = 1; generation <= 100; generation += 1) {
      const attachment: PresentationAttachment = {
        attachmentId: "embed",
        attachmentGeneration: generation,
        documentId: "drawing.svg",
        embedReference: {
          kind: "live-preview",
          documentId: "drawing.svg",
          from: 0,
          to: 20,
          sourcePath: "note.md",
        },
        root: root as unknown as HTMLElement,
        scrollOwner: () => root as unknown as HTMLElement,
      };
      runtime.mount(attachment);
      expect(listeners.size).toBe(1);
      runtime.detach(attachment);
      expect(listeners.size).toBe(0);
    }
    runtime.dispose();
    expect(listeners.size).toBe(0);
  } finally {
    runtime.dispose();
  }
});

it("defers all feedback allocation and positioning until the manual-opening threshold", () => {
  const { body, root, ownerWindow, frames } = createFramedPresentation();
  let timers = 0;
  Object.assign(ownerWindow, { setTimeout: () => ++timers });
  const read = vi.spyOn(root, "getBoundingClientRect");
  const insertion = vi.spyOn(body, "appendChild");
  const allocation = vi.spyOn(root, "createDiv");
  const feedback = new PresentationOperationFeedback(
    root as unknown as HTMLElement,
    undefined,
    workSchedulerFromFrames(ownerWindow),
  );
  const operation = feedback.begin("opening");
  expect(allocation).not.toHaveBeenCalled();
  expect(root.children).toHaveLength(0);
  expect(timers).toBe(1);
  for (let event = 0; event < 1_000; event += 1)
    root.ownerDocument.dispatchEvent(new Event("scroll"));
  expect(read).not.toHaveBeenCalled();
  expect(insertion).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
  operation.finish();
  feedback.dispose();
  expect(root.children).toHaveLength(0);
  expect(body.children).toEqual([root]);
});

it("hands off overdue loading feedback synchronously with bounded work", () => {
  const { body, root } = createPresentation();
  const ownerWindow = root.ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error("Missing owner window.");
  let scheduledWork = 0;
  Object.assign(ownerWindow, {
    performance: { now: () => 1000 },
    requestAnimationFrame: () => ++scheduledWork,
    setTimeout: () => ++scheduledWork,
  });
  const feedback = new PresentationOperationFeedback(
    root as unknown as HTMLElement,
    undefined,
    workSchedulerFromFrames(ownerWindow),
  );

  let invalidIndicators = 0;
  let retainedIndicators = 0;
  for (let sample = 0; sample < 2; sample += 1) {
    const operation = feedback.begin("loading", 0);
    const indicators = body.getElementsByClassName("inkbook-operation-feedback");
    const indicator = indicators.item(0);
    if (
      indicators.length !== 1 ||
      indicator?.style.insetBlockStart !== "50px" ||
      indicator.style.insetInlineStart !== "300px"
    ) {
      invalidIndicators += 1;
    }
    operation.finish();

    retainedIndicators += root.children.length + body.children.length - 1;
  }
  feedback.dispose();
  expect(invalidIndicators).toBe(0);
  expect(retainedIndicators).toBe(0);
  expect(scheduledWork).toBe(0);
});

it("positions detached loading feedback after attachment with bounded work", () => {
  const { body, root, ownerWindow, frames } = createFramedPresentation();
  let timers = 0;
  Object.assign(ownerWindow, {
    setTimeout: () => ++timers,
  });

  let invalidPositions = 0;
  let retainedResources = 0;
  const read = vi.spyOn(root, "getBoundingClientRect");
  const insertion = vi.spyOn(body, "appendChild");
  for (let sample = 0; sample < 2; sample += 1) {
    read.mockClear();
    insertion.mockClear();
    root.isConnected = false;
    const feedback = new PresentationOperationFeedback(
      root as unknown as HTMLElement,
      undefined,
      workSchedulerFromFrames(ownerWindow),
    );

    feedback.begin("loading", 0);
    const indicators = root.getElementsByClassName("inkbook-operation-feedback");
    const indicator = indicators.item(0);
    expect(read).not.toHaveBeenCalled();
    expect(insertion).not.toHaveBeenCalled();
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
    expect(read).toHaveBeenCalledOnce();
    expect(insertion).toHaveBeenCalledOnce();
    expect(indicator?.parentElement?.parentElement).toBe(body);
    if (
      indicator?.style.insetBlockStart !== "50px" ||
      indicator.style.insetInlineStart !== "300px"
    ) {
      invalidPositions += 1;
    }
    feedback.dispose();

    retainedResources += root.children.length + body.children.length - 1 + frames.size;
  }
  expect(invalidPositions).toBe(0);
  expect(retainedResources).toBe(0);
  expect(timers).toBe(0);
});

it("bounds actual loading layout reads and live insertion across a scroll burst", () => {
  const { body, root, ownerWindow, frames } = createFramedPresentation();
  const read = vi.spyOn(root, "getBoundingClientRect");
  const insertion = vi.spyOn(body, "appendChild");
  const scheduler = workSchedulerFromFrames(ownerWindow);
  const request = vi.spyOn(scheduler, "requestFrame");
  const feedback = new PresentationOperationFeedback(
    root as unknown as HTMLElement,
    undefined,
    scheduler,
  );
  feedback.begin("loading", 0);
  expect(read).toHaveBeenCalledOnce();
  expect(insertion).toHaveBeenCalledOnce();
  expect(read.mock.invocationCallOrder[0]).toBeLessThan(insertion.mock.invocationCallOrder[0]!);
  read.mockClear();
  for (let event = 0; event < 1_000; event += 1) {
    root.ownerDocument.dispatchEvent(new Event("scroll"));
  }
  expect(read).not.toHaveBeenCalled();
  expect(frames.size).toBe(1);
  expect(request).toHaveBeenCalledExactlyOnceWith(expect.any(Function), "input");
  for (const [handle, callback] of frames) {
    frames.delete(handle);
    callback(16);
  }
  expect(read).toHaveBeenCalledOnce();
  expect(insertion).toHaveBeenCalledOnce();
  root.ownerDocument.dispatchEvent(new Event("scroll"));
  feedback.dispose();
  expect(frames.size).toBe(0);
  expect(root.children).toHaveLength(0);
  expect(body.children).toEqual([root]);
  root.ownerDocument.dispatchEvent(new Event("scroll"));
  expect(frames.size).toBe(0);
});

function createPresentation() {
  const body = new FakePresentationElement();
  const root = new FakePresentationElement(body.ownerDocument);
  body.append(root);
  return { body, root };
}

function createFramedPresentation() {
  const presentation = createPresentation();
  const ownerWindow = presentation.root.ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error("Missing owner window.");
  const frames = new Map<number, FrameRequestCallback>();
  let handle = 0;
  Object.assign(ownerWindow, {
    performance: { now: () => 1000 },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++handle, callback);
      return handle;
    },
    cancelAnimationFrame: (handle: number) => frames.delete(handle),
  });
  return { ...presentation, ownerWindow, frames };
}
