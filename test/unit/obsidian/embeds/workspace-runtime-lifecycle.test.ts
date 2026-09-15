import { TFile, type Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import type { PresentationAttachment } from "../../../../src/obsidian/embeds/presentation-port";
import { WorkspaceRuntimeLifecycle } from "../../../../src/obsidian/embeds/workspace-runtime-lifecycle";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { createSnapshot } from "../../persistence/serialization/fixtures";

function createHarness(
  presentations: Array<{
    readonly attachment: PresentationAttachment;
    readonly scene: undefined;
  }> = [],
  queueAutoActivation = true,
  vault: Vault = { getFileByPath: () => null } as unknown as Vault,
) {
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
    presentations: () => presentations,
    reloadPresentation,
    vault,
  });
  if (queueAutoActivation) {
    lifecycle.queueAutoActivation("drawings/ink.svg", ownerWindow, vi.fn(), dismiss);
  }
  return { dismiss, lifecycle, notifyExternalChange, reloadPresentation, timers };
}

describe("WorkspaceRuntimeLifecycle", () => {
  it("dismisses the insertion undo hint only after the first stroke is persisted", () => {
    const harness = createHarness();
    const persisted = {
      documentId: "drawings/ink.svg",
      lockedAspectRatio: 4,
      outputHash: "hash",
      revision: 1,
    };

    harness.lifecycle.handlePersisted(persisted);
    expect(harness.dismiss).not.toHaveBeenCalled();
    harness.lifecycle.markFirstStroke(persisted.documentId);
    harness.lifecycle.handlePersisted({ ...persisted, revision: 2 });

    expect(harness.dismiss).toHaveBeenCalledOnce();
  });

  it("does not apply a live-store aspect ratio separately from the persisted source", () => {
    const setPreviewAspectRatio = vi.fn();
    const presentations = [
      {
        attachment: {
          documentId: "drawings/ink.svg",
          setPreviewAspectRatio,
        } as unknown as PresentationAttachment,
        scene: undefined,
      },
    ];
    const harness = createHarness(presentations, false);

    harness.lifecycle.handlePersisted({
      documentId: "drawings/ink.svg",
      lockedAspectRatio: 4,
      outputHash: "hash",
      revision: 1,
    });

    expect(setPreviewAspectRatio).not.toHaveBeenCalled();
  });

  it("refreshes the validated SVG source of an already locked presentation", () => {
    const setPreviewSource = vi.fn(async () => undefined);
    const file = new (TFile as unknown as new (path: string, size: number) => TFile)(
      "drawings/ink.svg",
      100,
    );
    const attachment = {
      documentId: file.path,
      root: { getElementsByTagName: () => ({ item: () => null, length: 0 }) },
      setPreviewSource,
    } as unknown as PresentationAttachment;
    const lifecycle = new WorkspaceRuntimeLifecycle({
      activate: vi.fn(),
      fallbackWindow: () => undefined,
      isDisposed: () => false,
      notifyExternalChange: vi.fn(async () => "ignored" as const),
      presentations: () => [{ attachment, scene: undefined }],
      reloadPresentation: vi.fn(),
      vault: {
        getFileByPath: () => file,
        getResourcePath: () => "app://vault/drawings/ink.svg",
      } as unknown as Vault,
    });

    lifecycle.handlePersisted({
      documentId: file.path,
      lockedAspectRatio: 4,
      outputHash: "hash",
      revision: 2,
    });

    expect(setPreviewSource).toHaveBeenCalledWith(
      "app://vault/drawings/ink.svg?inkbook-revision=2-hash",
    );
  });
});

describe("WorkspaceRuntimeLifecycle host synchronization", () => {
  it("coalesces a host modification and remounts a clean same-worker reload", async () => {
    const harness = createHarness();
    harness.lifecycle.handleVaultModification("drawings/ink.svg");
    harness.lifecycle.handleVaultModification("drawings/ink.svg");

    harness.timers[1]?.();
    await vi.waitFor(() => expect(harness.reloadPresentation).toHaveBeenCalledOnce());

    expect(harness.notifyExternalChange).toHaveBeenCalledOnce();
    expect(harness.reloadPresentation).toHaveBeenCalledWith("drawings/ink.svg");
  });

  it("ignores a Vault modification confirmed by the persisted read-back hook", async () => {
    const persisted = serializedDocument(1);
    const harness = createHarness([], true, persisted.vault);
    harness.lifecycle.handleVaultModification("drawings/ink.svg");
    harness.lifecycle.handlePersisted({
      documentId: "drawings/ink.svg",
      lockedAspectRatio: 4,
      outputHash: persisted.hash,
      revision: 1,
    });

    harness.timers[1]?.();
    await vi.waitFor(() => expect(persisted.read).toHaveBeenCalledOnce());
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.notifyExternalChange).not.toHaveBeenCalled();
    expect(harness.reloadPresentation).not.toHaveBeenCalled();
  });

  it("does not suppress a different persisted identity in the same coalescing window", async () => {
    const ownWrite = serializedDocument(1);
    const externalWrite = serializedDocument(2);
    ownWrite.read.mockResolvedValue(externalWrite.content);
    const harness = createHarness([], true, ownWrite.vault);
    harness.lifecycle.handleVaultModification("drawings/ink.svg");
    harness.lifecycle.handlePersisted({
      documentId: "drawings/ink.svg",
      lockedAspectRatio: 4,
      outputHash: ownWrite.hash,
      revision: 1,
    });

    harness.timers[1]?.();
    await vi.waitFor(() => expect(harness.notifyExternalChange).toHaveBeenCalledOnce());

    expect(harness.reloadPresentation).toHaveBeenCalledWith("drawings/ink.svg");
  });
});

function serializedDocument(revision: number) {
  const serialized = serializeInkbookDocument({ ...createSnapshot(), revision });
  if (!serialized.ok) throw new Error("The test SVG could not be serialized.");
  const content = serialized.value.svg;
  const file = new (TFile as unknown as new (path: string, size: number) => TFile)(
    "drawings/ink.svg",
    new TextEncoder().encode(content).byteLength,
  );
  const read = vi.fn(async () => content);
  return {
    content,
    file,
    hash: serialized.value.hash,
    read,
    vault: {
      getFileByPath: () => file,
      getResourcePath: () => "app://vault/drawings/ink.svg",
      read,
    } as unknown as Vault,
  };
}

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

  it.each(["abort", "replace", "dispose"])("releases reserved feedback on %s", (operation) => {
    const harness = createAutoActivationHarness();
    const { lifecycle, attachment } = harness;
    expect(lifecycle.hasPendingAutoActivation(attachment)).toBe(false);
    lifecycle.queueAutoActivation(attachment.documentId, harness.window, harness.onTimeout);
    lifecycle.continueAutoActivation(attachment);
    expect(lifecycle.hasPendingAutoActivation(attachment)).toBe(true);
    expect(lifecycle.hasPendingAutoActivation({ ...attachment, attachmentGeneration: 2 })).toBe(
      false,
    );
    if (operation === "abort") lifecycle.abortAutoActivation(attachment.documentId);
    else if (operation === "replace")
      lifecycle.queueAutoActivation("other.svg", harness.window, vi.fn());
    else lifecycle.dispose();
    expect(lifecycle.hasPendingAutoActivation(attachment)).toBe(false);
    expect(harness.autoActivationCancelled).toHaveBeenCalledExactlyOnceWith("embed:1");
    lifecycle.dispose();
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
  const autoActivationCancelled = vi.fn();
  const lifecycle = new WorkspaceRuntimeLifecycle({
    activate,
    autoActivationCancelled,
    fallbackWindow: () => ownerWindow,
    isDisposed: () => false,
    notifyExternalChange: vi.fn(async () => "ignored" as const),
    presentations: () => presentations,
    reloadPresentation: vi.fn(),
    vault: { getFileByPath: () => null } as unknown as Vault,
  });
  return {
    activate,
    autoActivationCancelled,
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

it("resumes a held initial presentation after the activation timeout", () => {
  const h = createAutoActivationHarness();
  const initialEntrance = {
    ready: Promise.resolve(true),
    activationReady: Promise.resolve(true),
    holdForActivation: vi.fn(),
    resumePreview: vi.fn(),
    revealActive: vi.fn(),
    showLoading: vi.fn(),
  };
  Object.assign(h.attachment, { initialEntrance });
  h.presentations.push({ attachment: h.attachment, scene: undefined });
  h.lifecycle.queueAutoActivation(h.attachment.documentId, h.window, h.onTimeout);
  expect(initialEntrance.holdForActivation).toHaveBeenCalledOnce();
  h.runTimeout(1);
  expect(initialEntrance.resumePreview).toHaveBeenCalledOnce();
  h.lifecycle.dispose();
});
