import { describe, expect, it, vi } from "vitest";

import { createBuiltInDeviceSettings } from "../../../../../src/domain/settings";
import type { PresentationAttachment } from "../../../../../src/obsidian/embeds/presentation/presentation-port";
import {
  resumeInitialWorkspacePreview,
  createWorkspaceMountedPresentation,
  createWorkspacePresentationStateSetter,
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
  } as PresentationAttachment;
  const mounted = createWorkspaceMountedPresentation(
    attachment,
    workSchedulerFromFrames(attachment.root.ownerDocument.defaultView as Window),
  );
  const operation = { finish: vi.fn() };
  const begin = vi.spyOn(mounted.feedback, "begin").mockReturnValue(operation);
  return { begin, operation, mounted, present };
}

it("resumes an abandoned initial reveal", () => {
  const harness = createHarness();
  const resumePreview = vi.fn();
  Object.assign(harness.mounted.attachment, { initialEntrance: { resumePreview } });
  resumeInitialWorkspacePreview(harness.mounted);
  expect(resumePreview).toHaveBeenCalledOnce();
  expect(harness.begin).not.toHaveBeenCalled();
  resumeInitialWorkspacePreview(undefined);
});

it("cancels failed activation feedback immediately while readiness can finish its visual lifetime", () => {
  const harness = createHarness();
  const setState = createWorkspacePresentationStateSetter(new Map());
  setState(harness.mounted.attachment, "load-error", harness.operation);
  expect(harness.operation.finish).toHaveBeenCalledExactlyOnceWith("immediate");
  harness.operation.finish.mockClear();
  setState(harness.mounted.attachment, "active", harness.operation);
  expect(harness.operation.finish).toHaveBeenCalledExactlyOnceWith();
});

describe("mounted presentation activation feedback", () => {
  it.each([
    [undefined, "opening"],
    [1, "loading"],
  ] as const)("begins %s activation with %s feedback", (attempt, kind) => {
    const harness = createHarness();
    const activation = beginWorkspaceActivation(harness.mounted, attempt);
    expect(harness.begin).toHaveBeenCalledExactlyOnceWith(kind);
    expect(activation?.feedback).toBe(harness.operation);
    expect(harness.operation.finish).not.toHaveBeenCalled();
  });

  it("reveals a held insertion only after automatic activation reaches its feedback paint", () => {
    const root = new FakePresentationElement();
    const ownerWindow = root.ownerDocument.defaultView as Window;
    const showLoading = vi.fn();
    let timer: (() => void) | undefined;
    let frame: FrameRequestCallback | undefined;
    const schedule = vi.fn((callback: () => void) => {
      timer = callback;
      return 1;
    });
    Object.assign(ownerWindow, { setTimeout: schedule });
    const mounted = createWorkspaceMountedPresentation(
      {
        root: root as unknown as HTMLElement,
        initialEntrance: { showLoading },
      } as unknown as PresentationAttachment,
      workSchedulerFromFrames({
        requestAnimationFrame: (callback) => {
          frame = callback;
          return 1;
        },
        cancelAnimationFrame: () => {
          frame = undefined;
        },
      }),
    );
    beginWorkspaceActivation(mounted, 1);
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 500);
    expect(showLoading).not.toHaveBeenCalled();
    timer?.();
    expect(showLoading).not.toHaveBeenCalled();
    frame?.(0);
    expect(showLoading).toHaveBeenCalledOnce();
    mounted.feedback.dispose();
  });

  it("does not complete activation feedback when the preview becomes ready", async () => {
    const harness = createHarness();
    const activation = beginWorkspaceActivation(harness.mounted, 1);
    harness.present(true);
    await Promise.resolve();
    expect(harness.operation.finish).not.toHaveBeenCalled();
    activation?.feedback?.finish();
    expect(harness.operation.finish).toHaveBeenCalledOnce();
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

it("retains the disabled scene until its owned input preparation allows disposal", () => {
  const h = releaseHarness();
  let allowRelease!: () => void;
  releaseWorkspaceScene(h.mounted, {
    ...h.options,
    waitForPreview: false,
    prepareRelease: (release) => {
      allowRelease = release;
    },
  });
  expect(h.scene.disableInput).toHaveBeenCalledOnce();
  expect(h.scene.dispose).not.toHaveBeenCalled();
  disposeWorkspaceMountedPresentations([h.mounted], true);
  expect(h.scene.dispose).not.toHaveBeenCalled();
  allowRelease();
  expect(h.scene.dispose).toHaveBeenCalledOnce();
  expect(h.mounted.scene).toBeUndefined();
});
