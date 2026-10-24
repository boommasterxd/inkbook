import { describe, expect, it, vi } from "vitest";

import { createBuiltInDeviceSettings } from "../../../../../src/domain/settings";
import type { PresentationAttachment } from "../../../../../src/obsidian/embeds/presentation/presentation-port";
import {
  cancelInitialWorkspaceLoading,
  createWorkspaceMountedPresentation,
  createWorkspacePresentationStateSetter,
  finishInitialWorkspaceLoading,
  startInitialWorkspaceLoading,
  updateWorkspaceMountedSettings,
  releaseWorkspaceScene,
  disposeWorkspaceMountedPresentations,
} from "../../../../../src/obsidian/embeds/workspace/workspace-mounted-presentation";
import type { ActiveInkbookScene } from "../../../../../src/obsidian/embeds/active-scene/active-scene";
import { beginWorkspaceActivation } from "../../../../../src/obsidian/embeds/workspace/workspace-runtime-scene-readiness";
import { FakePresentationElement } from "../../../../fixtures/obsidian/presentation-dom";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";

function createHarness() {
  let present: (ready: boolean) => void = () => undefined;
  const whenPresented = new Promise<boolean>((resolve) => {
    present = resolve;
  });
  const attachment = {
    root: new FakePresentationElement() as unknown as HTMLElement,
    whenPresented,
    loadingStartedAt: 100,
  } as PresentationAttachment;
  const mounted = createWorkspaceMountedPresentation(
    attachment,
    workSchedulerFromFrames(attachment.root.ownerDocument.defaultView as Window),
  );
  const initial = { finish: vi.fn() };
  const subsequent = { finish: vi.fn() };
  const begin = vi.spyOn(mounted.feedback, "begin").mockReturnValue(subsequent);
  begin.mockReturnValueOnce(initial);
  const lifecycle = { hasPendingAutoActivation: vi.fn(() => false) };
  return { begin, initial, lifecycle, mounted, present, subsequent };
}

describe("mounted presentation initial entrance", () => {
  it("releases an abandoned initial reveal before ending loading feedback", async () => {
    const harness = createHarness();
    const resumePreview = vi.fn();
    Object.assign(harness.mounted.attachment, { initialEntrance: { resumePreview } });
    startInitialWorkspaceLoading(harness.mounted, harness.lifecycle);
    cancelInitialWorkspaceLoading(harness.mounted);
    expect(resumePreview).toHaveBeenCalledOnce();
    harness.present(true);
    await Promise.resolve();
    expect(harness.initial.finish).toHaveBeenCalledOnce();
    cancelInitialWorkspaceLoading(undefined);
  });

  it("makes a held insertion visible when its loading feedback becomes overdue", () => {
    const showLoading = vi.fn();
    const attachment = {
      root: new FakePresentationElement() as unknown as HTMLElement,
      initialEntrance: { showLoading },
    } as unknown as PresentationAttachment;
    const mounted = createWorkspaceMountedPresentation(
      attachment,
      workSchedulerFromFrames(attachment.root.ownerDocument.defaultView as Window),
    );
    expect(showLoading).not.toHaveBeenCalled();
    mounted.feedback.begin("loading", -100_000);
    expect(showLoading).toHaveBeenCalledOnce();
    mounted.feedback.dispose();
  });
});

it("cancels failed activation feedback immediately while readiness can finish its visual lifetime", () => {
  const harness = createHarness();
  const setState = createWorkspacePresentationStateSetter(new Map());
  setState(harness.mounted.attachment, "load-error", harness.initial);
  expect(harness.initial.finish).toHaveBeenCalledExactlyOnceWith("immediate");
  setState(harness.mounted.attachment, "active", harness.subsequent);
  expect(harness.subsequent.finish).toHaveBeenCalledExactlyOnceWith();
});

describe("mounted presentation loading continuity", () => {
  it("ends initial loading when the locked preview becomes ready", async () => {
    const harness = createHarness();
    startInitialWorkspaceLoading(harness.mounted, harness.lifecycle);
    expect(harness.begin).toHaveBeenCalledWith("loading", 100);
    expect(harness.initial.finish).not.toHaveBeenCalled();
    harness.present(true);
    await Promise.resolve();
    expect(harness.initial.finish).toHaveBeenCalledOnce();
    expect(harness.mounted.initialLoading).toBeUndefined();
  });

  it("does not retain the original deadline for a later manual activation", async () => {
    const harness = createHarness();
    startInitialWorkspaceLoading(harness.mounted, harness.lifecycle);
    harness.present(true);
    await Promise.resolve();
    const activation = beginWorkspaceActivation(harness.mounted, undefined);
    expect(harness.begin).toHaveBeenLastCalledWith("opening");
    expect(activation?.feedback).toBe(harness.subsequent);
  });

  it("acknowledges a manual click while an initial reveal is still pending", async () => {
    const harness = await startPendingActivation("before-presentation");
    const activation = beginWorkspaceActivation(harness.mounted, undefined);
    expect(harness.begin).toHaveBeenLastCalledWith("opening");
    expect(activation?.feedback).toBe(harness.subsequent);
    harness.present(true);
    await Promise.resolve();
    expect(harness.subsequent.finish).not.toHaveBeenCalled();
  });

  it.each(["before-presentation", "after-presentation"])(
    "transfers one loading handle to automatic activation %s",
    async (order) => {
      const harness = await startPendingActivation(order);
      const activation = beginWorkspaceActivation(harness.mounted, 1);
      harness.present(true);
      await Promise.resolve();
      expect(harness.begin).toHaveBeenCalledOnce();
      expect(activation?.feedback).toBe(harness.initial);
      expect(harness.initial.finish).not.toHaveBeenCalled();
      expect(harness.mounted.initialLoading).toBeUndefined();
      activation?.feedback?.finish();
      expect(harness.initial.finish).toHaveBeenCalledOnce();
    },
  );

  it.each(["before-presentation", "after-presentation"])(
    "ends cancelled pending activation feedback %s",
    async (order) => {
      const harness = await startPendingActivation(order);
      harness.lifecycle.hasPendingAutoActivation.mockReturnValue(false);
      finishInitialWorkspaceLoading(harness.mounted);
      harness.present(true);
      await Promise.resolve();
      expect(harness.initial.finish).toHaveBeenCalledOnce();
      expect(harness.mounted.initialLoading).toBeUndefined();
      finishInitialWorkspaceLoading(harness.mounted);
      expect(harness.initial.finish).toHaveBeenCalledOnce();
    },
  );

  it("ends an abandoned presentation even while automatic activation was pending", async () => {
    const harness = createHarness();
    harness.lifecycle.hasPendingAutoActivation.mockReturnValue(true);
    startInitialWorkspaceLoading(harness.mounted, harness.lifecycle);
    harness.present(false);
    await Promise.resolve();
    expect(harness.initial.finish).toHaveBeenCalledOnce();
  });

  it("skips initial feedback without a recognition deadline", () => {
    const harness = createHarness();
    delete (harness.mounted.attachment as { loadingStartedAt?: number }).loadingStartedAt;
    startInitialWorkspaceLoading(harness.mounted, harness.lifecycle);
    expect(harness.begin).not.toHaveBeenCalled();
    finishInitialWorkspaceLoading(undefined);
  });

  it("ends loading for a presentation without an entrance barrier", async () => {
    const harness = createHarness();
    delete (harness.mounted.attachment as { whenPresented?: Promise<boolean> }).whenPresented;
    startInitialWorkspaceLoading(harness.mounted, harness.lifecycle);
    await Promise.resolve();
    expect(harness.initial.finish).toHaveBeenCalledOnce();
  });

  it("updates motion feedback for a locked presentation without an active scene", () => {
    const harness = createHarness();
    updateWorkspaceMountedSettings([harness.mounted], {
      ...createBuiltInDeviceSettings(),
      motion: "reduced",
    });
    expect(harness.mounted.attachment.root.dataset.inkbookMotion).toBe("reduced");
  });
});

async function startPendingActivation(order: string) {
  const harness = createHarness();
  harness.lifecycle.hasPendingAutoActivation.mockReturnValue(true);
  startInitialWorkspaceLoading(harness.mounted, harness.lifecycle);
  if (order === "after-presentation") {
    harness.present(true);
    await Promise.resolve();
  }
  return harness;
}

function releaseHarness() {
  const { mounted } = createHarness();
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const scene = { disableInput: vi.fn(), dispose: vi.fn(), finishLock: vi.fn(() => ready) };
  mounted.scene = scene as unknown as ActiveInkbookScene;
  const options = { waitForPreview: true, onLocked: vi.fn(), onFailure: vi.fn() };
  return { mounted, scene, options, finish, fail };
}

it("keeps a connected inactive scene until its safe preview is ready", async () => {
  const h = releaseHarness();
  releaseWorkspaceScene(h.mounted, h.options);
  expect(h.scene.disableInput).toHaveBeenCalledOnce();
  expect(h.scene.dispose).not.toHaveBeenCalled();
  h.finish();
  await Promise.resolve();
  expect(h.scene.dispose).toHaveBeenCalledOnce();
  expect(h.mounted.scene).toBeUndefined();
  expect(h.options.onLocked).toHaveBeenCalledOnce();
});

it.each(["reactivate", "detach", "unload"] as const)(
  "cannot publish an obsolete preview release after %s",
  async (action) => {
    const h = releaseHarness();
    releaseWorkspaceScene(h.mounted, h.options);
    if (action === "reactivate") beginWorkspaceActivation(h.mounted, undefined);
    else if (action === "detach")
      releaseWorkspaceScene(h.mounted, { ...h.options, waitForPreview: false });
    else disposeWorkspaceMountedPresentations([h.mounted]);
    const disposed = h.scene.dispose.mock.calls.length;
    h.finish();
    await Promise.resolve();
    expect(h.scene.dispose).toHaveBeenCalledTimes(disposed);
    expect(h.options.onLocked).toHaveBeenCalledTimes(action === "detach" ? 1 : 0);
  },
);

it("keeps the disabled image and reports preview reconstruction failure", async () => {
  const h = releaseHarness();
  releaseWorkspaceScene(h.mounted, h.options);
  h.fail(new Error("unsafe replacement"));
  await Promise.resolve();
  expect(h.scene.dispose).not.toHaveBeenCalled();
  expect(h.mounted.scene).toBe(h.scene);
  expect(h.options.onFailure).toHaveBeenCalledOnce();
  expect(h.options.onLocked).not.toHaveBeenCalled();
});
