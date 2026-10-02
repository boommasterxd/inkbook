import type { FileManager, Vault } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBuiltInDeviceSettings,
  createBuiltInSettings,
} from "../../../../src/domain/settings";
import type { WorkspaceEditorCoordinatorSnapshot } from "../../../../src/editor/session/workspace-editor-coordinator-types";
import type { PresentationAttachment } from "../../../../src/obsidian/embeds/presentation-port";
import { ObsidianWorkspaceRuntime } from "../../../../src/obsidian/embeds/workspace-runtime";
import { ColorSchemeBroadcaster } from "../../../../src/obsidian/theme/color-scheme";
import type { ObsidianEmbedActions } from "../../../../src/obsidian/commands";
import { InkbookFeedbackManager } from "../../../../src/obsidian/feedback";
import { FakePresentationElement } from "../../../fixtures/obsidian/presentation-dom";
import { SafeStaticProof } from "../../../../src/persistence/serialization/safe-static-proof";
import type { VaultDocumentSessionHooks } from "../../../../src/obsidian/embeds/vault-document-recovery";

const boundary = vi.hoisted(() => {
  const snapshot: WorkspaceEditorCoordinatorSnapshot = { disposed: false };
  return {
    snapshot,
    sessionHooks: undefined as VaultDocumentSessionHooks | undefined,
    createScene: vi.fn(),
    getEditorContext: vi.fn(() => ({ model: { getSaveStatus: () => "saved" as const } })),
    activationRequests: vi.fn(),
    updateHighlights: vi.fn(),
    prepareForUnload: vi.fn(async (): Promise<void> => undefined),
  };
});

vi.mock("../../../../src/editor/session/workspace-editor-coordinator", () => ({
  WorkspaceEditorCoordinator: class {
    mountAttachment() {
      return true;
    }
    detachAttachment() {
      return true;
    }
    getSnapshot() {
      return boundary.snapshot;
    }
    requestActivation(attachment: PresentationAttachment) {
      boundary.activationRequests(attachment);
      boundary.snapshot = {
        disposed: false,
        current: {
          attachment,
          dirty: false,
          documentId: attachment.documentId,
          persistencePending: false,
          phase: "active",
          revision: 0,
          sessionId: "session",
        },
      };
      return {
        token: 1,
        outcome: Promise.resolve({ kind: "activated", phase: "active", sessionId: "session" }),
      };
    }
    dispose() {
      boundary.snapshot = { disposed: true };
    }
  },
}));

vi.mock("../../../../src/obsidian/embeds/vault-document-session-factory", () => ({
  VaultDocumentSessionFactory: class {
    constructor(
      _vault: unknown,
      _fileManager: unknown,
      _runtimes: unknown,
      hooks: VaultDocumentSessionHooks,
    ) {
      boundary.sessionHooks = hooks;
    }
    getEditorContext = boundary.getEditorContext;
    prepareForUnload = boundary.prepareForUnload;
  },
}));

vi.mock("../../../../src/obsidian/embeds/workspace-active-scene", () => ({
  createWorkspaceActiveScene: boundary.createScene,
}));

function createHarness(initialEntrance?: PresentationAttachment["initialEntrance"]) {
  boundary.snapshot = { disposed: false };
  boundary.prepareForUnload.mockReset().mockResolvedValue(undefined);
  boundary.updateHighlights.mockClear();
  boundary.createScene.mockReset().mockImplementation(() => ({
    dispose: vi.fn(),
    ready: Promise.resolve(true),
    setScheme: vi.fn(),
    updateSnappingSettings: vi.fn(),
    updateSelectionHighlights: boundary.updateHighlights,
  }));
  boundary.getEditorContext.mockClear();
  boundary.activationRequests.mockClear();
  const root = new FakePresentationElement() as unknown as HTMLElement;
  const settings = { device: createBuiltInDeviceSettings(), vault: createBuiltInSettings() };
  const runtime = new ObsidianWorkspaceRuntime(
    {} as Vault,
    {} as FileManager,
    new ColorSchemeBroadcaster({ getColorScheme: () => "light" }),
    () => settings,
    {} as ObsidianEmbedActions,
    {
      fallbackOwnerWindow: () => root.ownerDocument.defaultView ?? undefined,
      manager: new InkbookFeedbackManager(),
      onOpenSettings: vi.fn(),
      onOpenShortcuts: vi.fn(),
    },
  );
  let finishEntrance: (ready: boolean) => void = () => undefined;
  const whenPresented = new Promise<boolean>((resolve) => {
    finishEntrance = resolve;
  });
  const attachment: PresentationAttachment = {
    attachmentId: "embed",
    attachmentGeneration: 1,
    documentId: "ink.svg",
    root,
    embedReference: {
      documentId: "ink.svg",
      from: 0,
      to: 20,
      kind: "live-preview",
      sourcePath: "note.md",
    },
    scrollOwner: () => root,
    whenPresented,
    ...(initialEntrance === undefined ? {} : { initialEntrance }),
  };
  runtime.mount(attachment);
  return { attachment, finishEntrance, runtime, settings };
}

const runtimes: ObsidianWorkspaceRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

function startActivation() {
  const harness = createHarness();
  runtimes.push(harness.runtime);
  harness.runtime.activate(harness.attachment);
  return harness;
}

describe("workspace activation entrance barrier", () => {
  it("forwards only the current host preview proof and releases its provider on disposal", () => {
    const { runtime } = createHarness();
    runtimes.push(runtime);
    const proof = SafeStaticProof.fromTrustedProducer("a".repeat(64), 100);
    const provider = vi.fn(() => proof);
    const currentProof = boundary.sessionHooks?.safeStaticProof;
    expect(currentProof?.("ink.svg")).toBeUndefined();
    runtime.setSafeStaticProofProvider(provider);
    expect(currentProof?.("ink.svg")).toBe(proof);
    expect(provider).toHaveBeenCalledWith("ink.svg");
    runtime.dispose();
    expect(currentProof?.("ink.svg")).toBeUndefined();
  });
  it("hydrates concurrently and mounts only after the presentation is ready", async () => {
    const { attachment, finishEntrance, runtime, settings } = startActivation();
    await Promise.resolve();
    expect(boundary.snapshot.current?.phase).toBe("active");
    expect(boundary.createScene).not.toHaveBeenCalled();
    expect(runtime.documentStatus.current()).toBeNull();
    finishEntrance(true);
    await vi.waitFor(() => expect(boundary.createScene).toHaveBeenCalledOnce());
    expect(runtime.documentStatus.current()).toEqual({ path: "ink.svg", status: "saved" });
    expect(runtime.getMotionPreference()).toBe(settings.device.motion);
    settings.device = { ...settings.device, motion: "reduced" };
    expect(runtime.getMotionPreference()).toBe("reduced");
    runtime.detach(attachment);
    expect(runtime.documentStatus.current()).toBeNull();
  });

  it("does not mount when presentation disposal resolves the barrier to false", async () => {
    const { finishEntrance } = startActivation();
    finishEntrance(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(boundary.createScene).not.toHaveBeenCalled();
  });

  it("rejects a replaced mount even when its coordinator identity still matches", async () => {
    const { attachment, finishEntrance, runtime } = startActivation();
    await Promise.resolve();
    runtime.detach(attachment);
    runtime.mount({ ...attachment, root: new FakePresentationElement() as unknown as HTMLElement });
    finishEntrance(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(boundary.createScene).not.toHaveBeenCalled();
  });

  it.each(["locking", "replaced-session", "replaced-attachment", "disposed"])(
    "rejects %s activation state after the entrance wait",
    async (change) => {
      const { finishEntrance, runtime } = startActivation();
      await Promise.resolve();
      const current = boundary.snapshot.current;
      if (current === undefined) throw new Error("Missing active session.");
      if (change === "disposed") runtime.dispose();
      else
        boundary.snapshot = {
          disposed: false,
          current: {
            ...current,
            ...(change === "locking" ? { phase: "locking" as const } : {}),
            ...(change === "replaced-session" ? { sessionId: "replacement" } : {}),
            ...(change === "replaced-attachment"
              ? { attachment: { attachmentId: "embed", attachmentGeneration: 2 } }
              : {}),
          },
        };
      finishEntrance(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(boundary.createScene).not.toHaveBeenCalled();
    },
  );
});

describe("coalesced workspace activation", () => {
  it.each(["locking", "locked"] as const)(
    "does not publish late scene readiness after the session becomes %s",
    async (phase) => {
      const { attachment, finishEntrance, runtime } = startActivation();
      let finishScene: (ready: boolean) => void = () => undefined;
      const ready = new Promise<boolean>((resolve) => {
        finishScene = resolve;
      });
      boundary.createScene.mockImplementationOnce(() => ({
        dispose: vi.fn(),
        ready,
        setScheme: vi.fn(),
      }));
      const changes = vi.fn();
      runtime.documentStatus.subscribe(changes);
      finishEntrance(true);
      await vi.waitFor(() => expect(boundary.createScene).toHaveBeenCalledOnce());
      const current = boundary.snapshot.current;
      if (current === undefined) throw new Error("Missing active session.");
      boundary.snapshot = { disposed: false, current: { ...current, phase } };
      attachment.root.dataset.inkbookState = phase;
      finishScene(true);
      await ready;
      expect(runtime.documentStatus.current()).toBeNull();
      expect(changes).not.toHaveBeenCalled();
      expect(attachment.root.dataset.inkbookState).toBe(phase);
    },
  );
  it.each(["auto-first", "manual-first"])(
    "preserves the auto attempt with %s invocation",
    async (order) => {
      const { attachment, finishEntrance, runtime } = createHarness();
      runtimes.push(runtime);
      const ownerWindow = attachment.root.ownerDocument.defaultView;
      if (ownerWindow === null) throw new Error("Missing owning window.");
      Object.defineProperty(ownerWindow, "setTimeout", { value: () => 42 });
      const clearTimeout = vi.spyOn(ownerWindow, "clearTimeout");
      const timeout = vi.fn();
      const auto = () => runtime.queueAutoActivation(attachment.documentId, ownerWindow, timeout);
      if (order === "auto-first") auto();
      runtime.activate(attachment);
      if (order === "manual-first") auto();
      await Promise.resolve();
      expect(boundary.activationRequests).toHaveBeenCalledOnce();
      expect(boundary.createScene).not.toHaveBeenCalled();
      finishEntrance(true);
      await vi.waitFor(() => expect(boundary.createScene).toHaveBeenCalledOnce());
      expect(clearTimeout).toHaveBeenCalledWith(42);
      expect(timeout).not.toHaveBeenCalled();
    },
  );

  it("keeps repeated clicks coalesced until the first scene becomes ready", async () => {
    const { attachment, finishEntrance, runtime } = startActivation();
    let ready: (value: boolean) => void = () => undefined;
    const sceneReady = new Promise<boolean>((resolve) => {
      ready = resolve;
    });
    boundary.createScene.mockImplementation(() => ({
      dispose: vi.fn(),
      ready: sceneReady,
      setScheme: vi.fn(),
    }));
    finishEntrance(true);
    await vi.waitFor(() => expect(boundary.createScene).toHaveBeenCalledOnce());
    runtime.activate(attachment);
    expect(boundary.activationRequests).toHaveBeenCalledOnce();
    ready(true);
    await vi.waitFor(() => expect(attachment.root.dataset.inkbookState).toBe("active"));
    expect(boundary.createScene).toHaveBeenCalledOnce();
  });

  it("releases a failed attempt so the mounted presentation can retry", async () => {
    const { attachment, finishEntrance, runtime } = startActivation();
    boundary.createScene.mockImplementationOnce(() => ({
      dispose: vi.fn(),
      ready: Promise.reject(new Error("Scene startup failed")),
      setScheme: vi.fn(),
    }));
    finishEntrance(true);
    await vi.waitFor(() => expect(attachment.root.dataset.inkbookState).toBe("load-error"));
    runtime.activate(attachment);
    await vi.waitFor(() => expect(boundary.createScene).toHaveBeenCalledTimes(2));
    expect(attachment.root.dataset.inkbookState).toBe("active");
  });
});

it("mounts a queued new editor after measurement without waiting for preview entrance", async () => {
  let measured: (ready: boolean) => void = () => undefined;
  const initialEntrance = {
    ready: Promise.resolve(true),
    activationReady: new Promise<boolean>((resolve) => {
      measured = resolve;
    }),
    holdForActivation: vi.fn(),
    resumePreview: vi.fn(),
    revealActive: vi.fn(() => true),
    showLoading: vi.fn(),
  };
  const h = createHarness(initialEntrance);
  runtimes.push(h.runtime);
  const ownerWindow = h.attachment.root.ownerDocument.defaultView!;
  h.runtime.queueAutoActivation(h.attachment.documentId, ownerWindow, vi.fn());
  expect(initialEntrance.holdForActivation).toHaveBeenCalledOnce();
  h.runtime.activate(h.attachment);
  await Promise.resolve();
  expect(boundary.createScene).not.toHaveBeenCalled();
  measured(true);
  await vi.waitFor(() => expect(boundary.createScene).toHaveBeenCalledOnce());
  expect(initialEntrance.resumePreview).not.toHaveBeenCalled();
});

it("propagates vault highlight changes to the mounted active presentation", async () => {
  const { finishEntrance, runtime, settings, attachment } = startActivation();
  finishEntrance(true);
  await vi.waitFor(() => expect(attachment.root.dataset.inkbookState).toBe("active"));
  runtime.updateVaultSettings({ ...settings.vault, selectionHighlightsEnabled: false });
  runtime.updateVaultSettings({ ...settings.vault, selectionHighlightsEnabled: true });
  expect(boundary.updateHighlights.mock.calls).toEqual([[false], [true]]);
});

it("retains window scheduling until detached persistence has drained", async () => {
  const { runtime, attachment } = createHarness();
  runtimes.push(runtime);
  const scheduler = runtime.refreshRateProfiles.workScheduler(
    attachment.root.ownerDocument.defaultView,
  );
  let finishDrain: () => void = () => undefined;
  boundary.prepareForUnload.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishDrain = () => resolve();
      }),
  );
  runtime.dispose();
  expect(runtime.refreshRateProfiles.workScheduler(attachment.root.ownerDocument.defaultView)).toBe(
    scheduler,
  );
  finishDrain();
  await Promise.resolve();
  expect(() =>
    runtime.refreshRateProfiles.workScheduler(attachment.root.ownerDocument.defaultView),
  ).toThrow("disposed");
});
