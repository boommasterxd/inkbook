import type { Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import type { PresentationAttachment } from "../../../../src/obsidian/embeds/presentation-port";
import { WorkspaceRuntimeLifecycle } from "../../../../src/obsidian/embeds/workspace-runtime-lifecycle";

function createHarness() {
  const dismiss = vi.fn();
  const notifyExternalChange = vi.fn(async () => "reloaded" as const);
  const reloadPresentation = vi.fn();
  const timers: Array<() => void> = [];
  const ownerWindow = {
    clearTimeout: vi.fn(),
    setTimeout: (callback: () => void) => {
      timers.push(callback);
      return timers.length;
    },
  } as unknown as Window;
  const lifecycle = new WorkspaceRuntimeLifecycle({
    activate: vi.fn(),
    fallbackWindow: () => ownerWindow,
    isDisposed: () => false,
    notifyExternalChange,
    presentations: () => [],
    reloadPresentation,
    vault: { getFileByPath: () => null } as unknown as Vault,
  });
  lifecycle.queueAutoActivation("drawings/ink.svg", ownerWindow, vi.fn(), dismiss);
  return { dismiss, lifecycle, notifyExternalChange, reloadPresentation, timers };
}

describe("WorkspaceRuntimeLifecycle", () => {
  it("dismisses the insertion undo hint only after the first stroke is persisted", () => {
    const harness = createHarness();
    const persisted = { documentId: "drawings/ink.svg", outputHash: "hash", revision: 1 };

    harness.lifecycle.handlePersisted(persisted);
    expect(harness.dismiss).not.toHaveBeenCalled();
    harness.lifecycle.markFirstStroke(persisted.documentId);
    harness.lifecycle.handlePersisted({ ...persisted, revision: 2 });

    expect(harness.dismiss).toHaveBeenCalledOnce();
  });

  it("coalesces a host modification and remounts a clean same-worker reload", async () => {
    const harness = createHarness();
    harness.lifecycle.handleVaultModification("drawings/ink.svg");
    harness.lifecycle.handleVaultModification("drawings/ink.svg");

    harness.timers[1]?.();
    await Promise.resolve();

    expect(harness.notifyExternalChange).toHaveBeenCalledOnce();
    expect(harness.reloadPresentation).toHaveBeenCalledWith("drawings/ink.svg");
  });

  it("ignores a Vault modification confirmed by the persisted read-back hook", async () => {
    const harness = createHarness();
    harness.lifecycle.handleVaultModification("drawings/ink.svg");
    harness.lifecycle.handlePersisted({
      documentId: "drawings/ink.svg",
      outputHash: "hash",
      revision: 1,
    });

    harness.timers[1]?.();
    await Promise.resolve();

    expect(harness.notifyExternalChange).not.toHaveBeenCalled();
    expect(harness.reloadPresentation).not.toHaveBeenCalled();
  });
});

describe("WorkspaceRuntimeLifecycle autoactivation", () => {
  it("retains autoactivation through its timeout and completes only the matching ready attempt", () => {
    const harness = createAutoActivationHarness();
    harness.lifecycle.queueAutoActivation(
      harness.attachment.documentId,
      harness.window,
      harness.onTimeout,
    );
    harness.lifecycle.continueAutoActivation(harness.attachment);

    harness.runNextFrame();
    harness.runNextFrame();
    expect(harness.activate).toHaveBeenCalledWith(harness.attachment, 1);

    harness.runTimeout(1);
    expect(harness.onTimeout).toHaveBeenCalledOnce();
    expect(harness.clearTimeout).not.toHaveBeenCalled();
    harness.lifecycle.completeAutoActivation(harness.attachment, 0);
    expect(harness.clearTimeout).not.toHaveBeenCalled();

    const retry = harness.onTimeout.mock.calls[0]?.[0];
    harness.presentations.push({ attachment: harness.attachment, scene: undefined });
    retry?.();
    expect(harness.pendingTimeouts()).toEqual([2]);
    harness.runNextFrame();
    harness.runNextFrame();
    expect(harness.activate).toHaveBeenLastCalledWith(harness.attachment, 2);
    harness.lifecycle.completeAutoActivation(harness.attachment, 1);
    expect(harness.pendingTimeouts()).toEqual([2]);
    harness.lifecycle.completeAutoActivation(harness.attachment, 2);
    expect(harness.clearTimeout).toHaveBeenCalledWith(2);
  });

  it("cancels scheduled autoactivation on abort, supersession, and dispose", () => {
    const harness = createAutoActivationHarness();
    harness.lifecycle.queueAutoActivation("drawings/ink.svg", harness.window, harness.onTimeout);
    harness.lifecycle.continueAutoActivation(harness.attachment);
    harness.lifecycle.abortAutoActivation("other.svg");
    expect(harness.cancelAnimationFrame).not.toHaveBeenCalled();

    harness.lifecycle.queueAutoActivation("drawings/new.svg", harness.window, vi.fn());
    expect(harness.cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(harness.clearTimeout).toHaveBeenCalledWith(1);
    harness.lifecycle.dispose();
    expect(harness.clearTimeout).toHaveBeenCalledWith(2);
  });

  it("moves a detached attempt to another mounted attachment without accepting stale completion", () => {
    const harness = createAutoActivationHarness();
    const replacement = { ...harness.attachment, attachmentGeneration: 2 };
    harness.lifecycle.queueAutoActivation(
      harness.attachment.documentId,
      harness.window,
      harness.onTimeout,
    );
    harness.lifecycle.continueAutoActivation(harness.attachment);

    harness.presentations.push({ attachment: replacement, scene: undefined });
    harness.lifecycle.detachAutoActivation(harness.attachment);
    harness.runFrame(1);
    harness.runNextFrame();
    harness.runNextFrame();
    expect(harness.activate).toHaveBeenCalledWith(replacement, 2);
    harness.lifecycle.completeAutoActivation(harness.attachment, 1);
    expect(harness.pendingTimeouts()).toEqual([1]);
    harness.lifecycle.completeAutoActivation(replacement, 2);
    expect(harness.clearTimeout).toHaveBeenCalledWith(1);
  });
});

function createAutoActivationHarness() {
  const frames = new Map<number, FrameRequestCallback>();
  const frameCallbacks = new Map<number, FrameRequestCallback>();
  const timeouts = new Map<number, () => void>();
  let nextFrame = 0;
  let nextTimeout = 0;
  const cancelAnimationFrame = vi.fn((handle: number) => frames.delete(handle));
  const clearTimeout = vi.fn((handle: number) => timeouts.delete(handle));
  const ownerWindow = {
    cancelAnimationFrame,
    clearTimeout,
    closed: false,
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      nextFrame += 1;
      frames.set(nextFrame, callback);
      frameCallbacks.set(nextFrame, callback);
      return nextFrame;
    }),
    setTimeout: vi.fn((callback: () => void) => {
      nextTimeout += 1;
      timeouts.set(nextTimeout, callback);
      return nextTimeout;
    }),
  } as unknown as Window;
  const ownerDocument = { defaultView: ownerWindow } as Document;
  Object.defineProperty(ownerWindow, "document", { value: ownerDocument });
  const attachment = {
    attachmentGeneration: 1,
    attachmentId: "embed",
    documentId: "drawings/ink.svg",
    root: { ownerDocument },
  } as unknown as PresentationAttachment;
  const presentations: Array<{ attachment: PresentationAttachment; scene: undefined }> = [];
  const activate = vi.fn();
  const onTimeout = vi.fn<(retry: () => void) => void>();
  const lifecycle = new WorkspaceRuntimeLifecycle({
    activate,
    fallbackWindow: () => ownerWindow,
    isDisposed: () => false,
    notifyExternalChange: vi.fn(async () => "ignored" as const),
    presentations: () => presentations,
    reloadPresentation: vi.fn(),
    vault: { getFileByPath: () => null } as unknown as Vault,
  });
  return {
    activate,
    attachment,
    cancelAnimationFrame,
    clearTimeout,
    lifecycle,
    onTimeout,
    pendingTimeouts: () => [...timeouts.keys()],
    presentations,
    runNextFrame: () => {
      const entry = frames.entries().next().value;
      if (entry === undefined) throw new Error("Expected a pending animation frame.");
      frames.delete(entry[0]);
      entry[1](0);
    },
    runFrame: (handle: number) => frameCallbacks.get(handle)?.(0),
    runTimeout: (handle: number) => {
      const callback = timeouts.get(handle);
      if (callback === undefined) throw new Error(`Expected timeout ${String(handle)}.`);
      timeouts.delete(handle);
      callback();
    },
    window: ownerWindow,
  };
}
