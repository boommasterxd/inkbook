import { describe, expect, it, vi } from "vitest";

import { createBuiltInDeviceSettings } from "../../../../src/domain/settings";
import type { PresentationAttachment } from "../../../../src/obsidian/embeds/presentation-port";
import {
  createWorkspaceMountedPresentation,
  finishInitialWorkspaceLoading,
  startInitialWorkspaceLoading,
  updateWorkspaceMountedSettings,
} from "../../../../src/obsidian/embeds/workspace-mounted-presentation";
import { beginWorkspaceActivation } from "../../../../src/obsidian/embeds/workspace-runtime-scene-readiness";
import { FakePresentationElement } from "../../../fixtures/obsidian/presentation-dom";

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
  const mounted = createWorkspaceMountedPresentation(attachment);
  const initial = { finish: vi.fn() };
  const subsequent = { finish: vi.fn() };
  const begin = vi.spyOn(mounted.feedback, "begin").mockReturnValue(subsequent);
  begin.mockReturnValueOnce(initial);
  const lifecycle = { hasPendingAutoActivation: vi.fn(() => false) };
  return { begin, initial, lifecycle, mounted, present, subsequent };
}

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
    expect(harness.begin).toHaveBeenLastCalledWith("loading");
    expect(activation?.feedback).toBe(harness.subsequent);
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
